const express      = require("express");
const cors         = require("cors");
const { chromium } = require("playwright");
const fs           = require("fs");
const path         = require("path");

const app          = express();
const PORT         = process.env.PORT || 3001;
const SESSION_FILE = path.join(__dirname, "topin-session.json");

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── SSE broadcast ─────────────────────────────────────────────
const sseClients = new Set();
let jobRunning      = false;
let cancelRequested = false;
let browser         = null;
let pendingAuthCtx  = null;
let activeCtx       = null;
// Keep the exact page that was alive after OTP — preserves React in-memory auth state.
// Direct pg.goto('/create-assessment') from a NEW page redirects to login because
// Topin's auth token lives in the running React app's memory, not just cookies/localStorage.
let activePg        = null;

function broadcast(type, message, extra = {}) {
  const payload = JSON.stringify({ type, message, ts: new Date().toISOString(), ...extra });
  sseClients.forEach(res => { try { res.write(`data: ${payload}\n\n`); } catch {} });
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ── Health ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ── SSE stream ────────────────────────────────────────────────
app.get("/api/publish/progress", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", message: "SSE connected", ts: new Date().toISOString() })}\n\n`);
  req.on("close", () => sseClients.delete(res));
});

// ── Helpers ───────────────────────────────────────────────────
async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    // Set HEADLESS=false in env to watch the browser during debugging
    browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  }
  return browser;
}

function onLoginPage(pg) {
  const url = pg.url();
  return url.includes("accounts.ccbp.in") || url.includes("/login?") || url === "about:blank";
}

// Creates a fresh context from session file, loads home, sets activeCtx/activePg.
// Returns the page if session is valid, null if not.
async function restoreSessionFromFile() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const b  = await ensureBrowser();
    const c  = await b.newContext({ storageState: SESSION_FILE });
    const pg = await c.newPage();
    await pg.goto("https://config.topin.tech/home", { waitUntil: "networkidle", timeout: 25000 });
    if (onLoginPage(pg)) { await c.close(); return null; }
    activeCtx = c;
    activePg  = pg;
    return pg;
  } catch {
    return null;
  }
}

// ── Step 1: Start login ───────────────────────────────────────
app.post("/api/publish/start", async (req, res) => {
  const { mobile } = req.body || {};
  if (!mobile) return res.status(400).json({ error: "mobile number required" });
  if (jobRunning) return res.status(409).json({ error: "A job is already running" });

  try {
    // Check live page first (fastest)
    if (activePg && !activePg.isClosed()) {
      try {
        await activePg.goto("https://config.topin.tech/home", { waitUntil: "domcontentloaded", timeout: 12000 });
        if (!onLoginPage(activePg)) {
          broadcast("success", "Existing session valid — skipping OTP");
          return res.json({ status: "already_authenticated" });
        }
      } catch {}
    }

    // Dead session — clean up
    activePg = null;
    if (activeCtx) { await activeCtx.close().catch(() => {}); activeCtx = null; }

    // Try session file
    broadcast("info", "Checking saved session...");
    const savedPg = await restoreSessionFromFile();
    if (savedPg) {
      broadcast("success", "Saved session valid — skipping OTP");
      return res.json({ status: "already_authenticated" });
    }

    // Fresh login flow
    broadcast("info", "Opening Topin login page...");
    const b  = await ensureBrowser();
    pendingAuthCtx = await b.newContext();
    const pg = await pendingAuthCtx.newPage();

    // config.topin.tech does a JS redirect → accounts.ccbp.in/login
    // Must wait for networkidle so the redirect fully completes before querying DOM
    await pg.goto("https://config.topin.tech/", { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!pg.url().includes("ccbp.in")) {
      await pg.waitForURL(url => url.href.includes("ccbp.in") || url.href.includes("login"), { timeout: 15000 }).catch(() => {});
    }
    await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    broadcast("info", `Login page: ${pg.url().split("?")[0]}`);

    // Mobile input — accounts.ccbp.in may use different placeholder than config.topin.tech
    const mobileInput = pg.locator([
      'input[placeholder="Enter Number"]',
      'input[placeholder*="mobile" i]',
      'input[placeholder*="phone" i]',
      'input[placeholder*="number" i]',
      'input[type="tel"]',
      'input[name*="mobile" i]',
      'input[name*="phone" i]',
      'input[id*="mobile" i]',
    ].join(", ")).first();
    await mobileInput.waitFor({ state: "visible", timeout: 15000 });
    await mobileInput.fill(mobile);

    await pg.locator([
      'button:has-text("GET OTP")',
      'button:has-text("Get OTP")',
      'button:has-text("Send OTP")',
      'button:has-text("Request OTP")',
      'button:has-text("Continue")',
      'button[type="submit"]',
    ].join(", ")).first().click({ timeout: 10000 });

    broadcast("info", `OTP sent to ${mobile.replace(/\d(?=\d{4})/g, "*")} — enter it in the portal`);
    res.json({ status: "otp_sent" });
  } catch (e) {
    broadcast("error", `Login start failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 2: Verify OTP ────────────────────────────────────────
app.post("/api/publish/verify-otp", async (req, res) => {
  const { otp } = req.body || {};
  if (!otp || String(otp).length !== 6) return res.status(400).json({ error: "6-digit OTP required" });
  if (!pendingAuthCtx) return res.status(400).json({ error: "No login in progress — call /start first" });

  try {
    const pages = pendingAuthCtx.pages();
    const pg    = pages[pages.length - 1];
    const otpStr = String(otp);
    // Wait for OTP screen to be fully rendered
    await pg.waitForTimeout(600);
    broadcast("info", `OTP page URL: ${pg.url().split("?")[0]}`);

    // Log every visible input so we can see exactly what the page has
    const allVisible = await pg.locator('input:visible').all();
    broadcast("info", `Visible inputs found: ${allVisible.length}`);
    for (let i = 0; i < Math.min(allVisible.length, 8); i++) {
      const info = await allVisible[i].evaluate(el =>
        `type=${el.type} maxLength=${el.maxLength} ph="${el.placeholder}" id="${el.id}" cls="${el.className.slice(0,40)}"`
      ).catch(() => "?");
      broadcast("info", `  input[${i}]: ${info}`);
    }

    broadcast("info", "Filling OTP...");

    // React sets maxLength as a DOM *property* (not HTML attribute), so use el.maxLength not getAttribute
    const digitBoxes = [];
    for (const inp of allVisible) {
      const maxLen = await inp.evaluate(el => el.maxLength).catch(() => -1);
      if (maxLen === 1) digitBoxes.push(inp);
    }
    broadcast("info", `Digit boxes (maxLength=1): ${digitBoxes.length}`);

    if (digitBoxes.length >= 6) {
      // 6 individual OTP boxes — click + press each digit (simulates real keystrokes)
      for (let i = 0; i < 6; i++) {
        await digitBoxes[i].click();
        await pg.keyboard.press(otpStr[i]);
        await pg.waitForTimeout(120);
      }
    } else if (digitBoxes.length > 0 && digitBoxes.length < 6) {
      // Fewer boxes than expected — fill what's visible and keyboard-type rest
      await digitBoxes[0].click();
      await pg.keyboard.type(otpStr, { delay: 120 });
    } else {
      // No maxLength=1 boxes — could be a single OTP field or different structure
      // Try single-field selectors first
      const singleOtp = pg.locator([
        'input[autocomplete="one-time-code"]',
        'input[maxlength="6"]',
        'input[placeholder*="OTP" i]',
        'input[placeholder*="code" i]',
        'input[placeholder*="verification" i]',
      ].join(", ")).first();

      if (await singleOtp.count()) {
        await singleOtp.click();
        await singleOtp.fill(otpStr);
      } else if (allVisible.length > 0) {
        // Last resort: click first visible input and keyboard-type the OTP
        // (works for any OTP implementation that auto-advances focus)
        broadcast("info", "Using keyboard fallback to fill OTP...");
        await allVisible[0].click();
        await pg.waitForTimeout(200);
        await pg.keyboard.type(otpStr, { delay: 150 });
      } else {
        throw new Error("No input fields found on OTP page — cannot fill OTP");
      }
    }
    await pg.waitForTimeout(300);

    broadcast("info", "Clicking Verify & Login...");
    const verifyBtn = pg.locator([
      'button:has-text("Verify & Login")',
      'button:has-text("Verify and Login")',
      'button:has-text("Verify OTP")',
      'button:has-text("Verify")',
      'button[type="submit"]',
    ].join(", ")).first();
    await verifyBtn.click({ timeout: 10000 });

    // Wait until we leave the ccbp.in login domain
    await pg.waitForURL("**/config.topin.tech/**", { timeout: 25000 });

    if (onLoginPage(pg)) throw new Error("Still on login page — OTP may be incorrect or expired");

    broadcast("info", "Logged in — waiting for app to fully initialise...");
    // Wait for React to set up auth state in memory before we save storage state
    await pg.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await pg.waitForTimeout(1500);

    await pendingAuthCtx.storageState({ path: SESSION_FILE });

    activeCtx      = pendingAuthCtx;
    activePg       = pg;   // preserve this exact page — React auth state is live here
    pendingAuthCtx = null;

    broadcast("success", "Logged into Topin — ready to publish");
    res.json({ status: "authenticated" });
  } catch (e) {
    broadcast("error", `OTP verification failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 3: Publish ───────────────────────────────────────────
app.post("/api/publish/run", async (req, res) => {
  if (jobRunning) return res.status(409).json({ error: "A job is already running" });

  const {
    assessmentName, assessmentDate, startTime, endTime,
    uniqueExamId,   exitPin = "1234", accessType = "Public",
  } = req.body || {};

  if (!assessmentName || !assessmentDate || !startTime || !endTime || !uniqueExamId)
    return res.status(400).json({ error: "Missing: assessmentName, assessmentDate, startTime, endTime, uniqueExamId" });

  res.json({ status: "started" });
  jobRunning = true; cancelRequested = false;

  (async () => {
    let ownedCtx = null;  // only close if we created it in this run
    let pg;
    try {
      const b = await ensureBrowser();

      if (activePg && !activePg.isClosed()) {
        // Best path: reuse the live page that still has React auth in memory
        pg = activePg;
        broadcast("info", "Using live authenticated session...");
      } else if (fs.existsSync(SESSION_FILE)) {
        // Fallback: restore from saved cookies/localStorage
        broadcast("info", "Restoring session from file...");
        ownedCtx = await b.newContext({ storageState: SESSION_FILE });
        pg = await ownedCtx.newPage();
        activeCtx = ownedCtx; activePg = pg;
      } else {
        broadcast("error", "No session found. Log in via the Credentials tab first.");
        return;
      }

      // ── Verify auth ──────────────────────────────────────────
      broadcast("info", "Verifying Topin session...");
      await pg.goto("https://config.topin.tech/home", { waitUntil: "networkidle", timeout: 30000 });

      if (onLoginPage(pg)) {
        activeCtx = null; activePg = null;
        broadcast("error", "Session expired — please log in again via the Credentials tab.");
        return;
      }

      if (cancelRequested) { broadcast("info", "Cancelled"); return; }

      // ── Navigate to create-assessment via SPA click (avoids page reload) ──
      broadcast("info", "Opening Create Assessment...");
      let reachedPage = false;

      const createLink = pg.locator([
        'a[href*="create-assessment"]',
        'a:has-text("Create Assessment")',
        'button:has-text("Create Assessment")',
        'li:has-text("Create Assessment") a',
        'nav a:has-text("Create")',
        '.sidebar a:has-text("Create")',
      ].join(", ")).first();

      if (await createLink.isVisible({ timeout: 4000 }).catch(() => false)) {
        await createLink.click();
        await pg.waitForURL("**/create-assessment**", { timeout: 12000 }).catch(() => {});
        reachedPage = pg.url().includes("create-assessment") && !onLoginPage(pg);
      }

      if (!reachedPage) {
        // Direct URL fallback — works if auth is properly in localStorage/cookies
        await pg.goto("https://config.topin.tech/create-assessment", { waitUntil: "networkidle", timeout: 30000 });
      }

      if (onLoginPage(pg)) {
        // Session valid on home but not on create-assessment means their SPA
        // stores auth in memory only. User must re-login and publish immediately.
        activeCtx = null; activePg = null;
        broadcast("error", "Redirected to login on Create Assessment page. Please log in again and click Publish immediately (do not navigate away first).");
        return;
      }

      // Wait for the name input to appear
      broadcast("info", "Waiting for form...");
      await pg.waitForSelector([
        'input[placeholder="Enter Assessment Name"]',
        'input[placeholder*="Assessment" i]',
        'input[name*="name" i]',
      ].join(", "), { timeout: 25000 });

      // ── Assessment name ──────────────────────────────────────
      broadcast("info", "Filling assessment name...");
      const nameInput = pg.locator([
        'input[placeholder="Enter Assessment Name"]',
        'input[placeholder*="Assessment Name" i]',
        'input[name*="name" i]',
      ].join(", ")).first();
      await nameInput.fill(assessmentName);

      // ── Exam ID tag ──────────────────────────────────────────
      broadcast("info", "Adding exam ID tag...");
      const tagInput = pg.locator('[placeholder*="tag" i], [placeholder*="Tag"], [placeholder*="label" i]').first();
      if (await tagInput.count()) {
        await tagInput.fill(uniqueExamId);
        await tagInput.press("Enter");
        await pg.waitForTimeout(400);
      }

      if (cancelRequested) { broadcast("info", "Cancelled"); return; }

      // ── Schedule ─────────────────────────────────────────────
      broadcast("info", "Setting schedule...");
      await setDateTimeField(pg, "start", assessmentDate, startTime);
      await setDateTimeField(pg, "end",   assessmentDate, endTime);

      // ── Exam environment ─────────────────────────────────────
      broadcast("info", "Configuring exam environment...");
      const exitPinField = pg.locator([
        '[data-testid="ao-exam-environment-option"] input',
        'input[placeholder*="PIN" i]',
        'input[placeholder*="pin" i]',
        'input[placeholder*="exit" i]',
      ].join(", ")).first();
      if (await exitPinField.count()) await exitPinField.fill(exitPin);

      const qrToggle = pg.locator('text=/QR.*attendance/i >> .. >> input[type="checkbox"]').first();
      if (await qrToggle.count() && !(await qrToggle.isChecked())) await qrToggle.check();

      const pinToggle = pg.locator('text=/Common Start PIN/i >> .. >> input[type="checkbox"]').first();
      if (await pinToggle.count() && !(await pinToggle.isChecked())) await pinToggle.check();

      if (cancelRequested) { broadcast("info", "Cancelled"); return; }

      // ── Publish ──────────────────────────────────────────────
      broadcast("info", "Clicking Publish Assessment...");
      const publishBtn = pg.locator([
        'button:has-text("Publish Assessment")',
        'button:has-text("Publish")',
        'button[type="submit"]',
      ].join(", ")).first();
      await publishBtn.click({ timeout: 15000 });
      await pg.waitForTimeout(1500);

      // Access type dialog
      const accessBtn = pg.locator(`button:has-text("${accessType}")`).first();
      if (await accessBtn.count()) await accessBtn.click();

      const agreeBtn = pg.locator([
        'button:has-text("Yes, I agree")',
        'button:has-text("Agree")',
        'button:has-text("Confirm")',
      ].join(", ")).first();
      if (await agreeBtn.count()) await agreeBtn.click();

      await pg.waitForTimeout(2500);

      // ── Extract link ─────────────────────────────────────────
      broadcast("info", "Extracting assessment link...");
      let assessmentLink = "";
      try {
        assessmentLink = await pg.evaluate(() => navigator.clipboard.readText());
      } catch {}
      if (!assessmentLink) {
        const linkEl = pg.locator([
          'input[value*="org_id="]',
          'input[value*="topin"]',
          'a[href*="take.topin"]',
          'a[href*="topin.tech"]',
        ].join(", ")).first();
        if (await linkEl.count()) {
          try { assessmentLink = await linkEl.inputValue(); } catch { assessmentLink = await linkEl.getAttribute("href").catch(() => ""); }
        }
      }

      const urlMatch = pg.url().match(/\/(?:edit|view)-assessment\/([0-9a-f-]{36})/i);
      await activeCtx?.storageState({ path: SESSION_FILE }).catch(() => {});

      broadcast("done", "Assessment published on Topin", {
        assessmentLink,
        assessmentId: urlMatch?.[1] || "",
      });
    } catch (e) {
      broadcast("error", `Publish failed: ${e.message}`);
    } finally {
      // Only close context if we created it in this run (session file fallback)
      if (ownedCtx && ownedCtx !== activeCtx) await ownedCtx.close().catch(() => {});
      jobRunning = false;
    }
  })();
});

// ── Cancel ────────────────────────────────────────────────────
app.post("/api/publish/cancel", (_req, res) => {
  cancelRequested = true;
  broadcast("info", "Cancellation requested...");
  res.json({ status: "cancelling" });
});

// ── Date/time helper ──────────────────────────────────────────
async function setDateTimeField(pg, field, dateStr, timeStr) {
  const [yyyy, mm, dd] = dateStr.split("-");
  const [hh, min]      = timeStr.split(":");

  const dateInput = pg.locator([
    `[data-field="${field}-date"] input`,
    `input[name="${field}Date"]`,
    `input[placeholder*="${field === "start" ? "start" : "end"} date" i]`,
    `input[placeholder*="date" i]`,
  ].join(", ")).first();
  if (await dateInput.count()) await dateInput.fill(`${mm}/${dd}/${yyyy}`);

  const timeInput = pg.locator([
    `[data-field="${field}-time"] input`,
    `input[name="${field}Time"]`,
    `input[placeholder*="${field === "start" ? "start" : "end"} time" i]`,
    `input[placeholder*="time" i]`,
  ].join(", ")).first();
  if (await timeInput.count()) await timeInput.fill(`${hh}:${min}`);
}

app.listen(PORT, () => {
  console.log("─────────────────────────────────────────────");
  console.log(`  IOE Portal Automation Server`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  Health:     http://localhost:${PORT}/api/health`);
  console.log(`  Set HEADLESS=false to watch the browser`);
  console.log("─────────────────────────────────────────────");
});
