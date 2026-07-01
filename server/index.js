/**
 * IOE Admin Portal — Local Automation Server
 * Handles Topin assessment publishing via Playwright browser automation.
 *
 * Setup:
 *   cd server && npm install && npm run install-browsers && npm start
 *
 * Then set the Local Server URL in the portal's Credentials tab to:
 *   http://localhost:3001
 */

const express    = require("express");
const cors       = require("cors");
const { chromium } = require("playwright");
const fs         = require("fs");
const path       = require("path");

const app          = express();
const PORT         = process.env.PORT || 3001;
const SESSION_FILE = path.join(__dirname, "topin-session.json");

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── SSE broadcast ─────────────────────────────────────────────
const sseClients = new Set();
let jobRunning       = false;
let cancelRequested  = false;
let browser          = null;
let pendingAuthCtx   = null; // context waiting for OTP

function broadcast(type, message, extra = {}) {
  const payload = JSON.stringify({ type, message, ts: new Date().toISOString(), ...extra });
  sseClients.forEach(res => { try { res.write(`data: ${payload}\n\n`); } catch {} });
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ── Health ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ── SSE progress stream ───────────────────────────────────────
app.get("/api/publish/progress", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  sseClients.add(res);
  const hello = JSON.stringify({ type: "connected", message: "SSE connected", ts: new Date().toISOString() });
  res.write(`data: ${hello}\n\n`);
  req.on("close", () => sseClients.delete(res));
});

// ── Session helpers ───────────────────────────────────────────
async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function isSessionValid() {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const b   = await ensureBrowser();
    const ctx = await b.newContext({ storageState: SESSION_FILE });
    const pg  = await ctx.newPage();
    await pg.goto("https://config.topin.tech/home", { waitUntil: "domcontentloaded", timeout: 20000 });
    const valid = pg.url().includes("config.topin.tech") && !pg.url().includes("accounts.ccbp.in");
    await ctx.close();
    return valid;
  } catch { return false; }
}

// ── Step 1: Start login — enter mobile, trigger OTP ──────────
app.post("/api/publish/start", async (req, res) => {
  const { mobile } = req.body || {};
  if (!mobile) return res.status(400).json({ error: "mobile number required" });
  if (jobRunning) return res.status(409).json({ error: "A job is already running" });

  try {
    broadcast("info", "Checking existing Topin session...");
    if (await isSessionValid()) {
      broadcast("success", "Existing session valid — skipping OTP");
      return res.json({ status: "already_authenticated" });
    }

    broadcast("info", "Opening Topin login page...");
    const b   = await ensureBrowser();
    pendingAuthCtx = await b.newContext();
    const pg  = await pendingAuthCtx.newPage();

    await pg.goto("https://config.topin.tech/", { waitUntil: "domcontentloaded", timeout: 30000 });

    broadcast("info", `Entering mobile number: ${mobile.replace(/\d(?=\d{4})/g, "*")}`);
    await pg.fill('input[placeholder="Enter Number"]', mobile);
    await pg.click('button:has-text("GET OTP")');

    broadcast("info", "OTP sent to mobile — enter it in the portal to continue");
    res.json({ status: "otp_sent" });
  } catch (e) {
    broadcast("error", `Login start failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 2: Submit OTP ────────────────────────────────────────
app.post("/api/publish/verify-otp", async (req, res) => {
  const { otp } = req.body || {};
  if (!otp || String(otp).length !== 6) return res.status(400).json({ error: "6-digit OTP required" });
  if (!pendingAuthCtx) return res.status(400).json({ error: "No login in progress. Call /start first." });

  try {
    const pages = pendingAuthCtx.pages();
    const pg    = pages[pages.length - 1];
    broadcast("info", "Filling OTP digits...");

    const digits = String(otp).split("");
    for (let i = 0; i < digits.length; i++) {
      const sel = `[aria-label*="Digit ${i + 1}"], [aria-label*="verification code ${i + 1}"]`;
      const inp = pg.locator(sel).first();
      if (await inp.count()) await inp.fill(digits[i]);
    }

    broadcast("info", "Clicking Verify & Login...");
    await pg.click('button:has-text(/Verify & Login/i)');
    await pg.waitForURL("**/config.topin.tech/**", { timeout: 15000 });

    await pendingAuthCtx.storageState({ path: SESSION_FILE });
    broadcast("success", "Logged in to Topin ✓ — session saved");
    pendingAuthCtx = null;
    res.json({ status: "authenticated" });
  } catch (e) {
    broadcast("error", `OTP verification failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 3: Publish one assessment ───────────────────────────
// Body: { assessmentName, assessmentDate (YYYY-MM-DD), startTime (HH:MM), endTime (HH:MM),
//         uniqueExamId, exitPin (optional, default "1234"), accessType ("Public"|"Private") }
app.post("/api/publish/run", async (req, res) => {
  if (jobRunning) return res.status(409).json({ error: "A job is already running" });

  const {
    assessmentName, assessmentDate, startTime, endTime,
    uniqueExamId,   exitPin = "1234", accessType = "Public"
  } = req.body || {};

  if (!assessmentName || !assessmentDate || !startTime || !endTime || !uniqueExamId) {
    return res.status(400).json({ error: "Missing: assessmentName, assessmentDate, startTime, endTime, uniqueExamId" });
  }

  res.json({ status: "started" });
  jobRunning      = true;
  cancelRequested = false;

  (async () => {
    let ctx, pg;
    try {
      const b = await ensureBrowser();
      ctx = fs.existsSync(SESSION_FILE)
        ? await b.newContext({ storageState: SESSION_FILE })
        : await b.newContext();
      pg = await ctx.newPage();

      broadcast("info", "Navigating to Topin config dashboard...");
      await pg.goto("https://config.topin.tech/home", { waitUntil: "domcontentloaded", timeout: 30000 });

      if (!pg.url().includes("config.topin.tech") || pg.url().includes("accounts.ccbp.in")) {
        broadcast("error", "Not authenticated. Log in via the Credentials tab first.");
        return;
      }

      if (cancelRequested) { broadcast("info", "Cancelled"); return; }

      // ── Navigate to create assessment ────────────────────────
      broadcast("info", "Opening Create Assessment page...");
      await pg.goto("https://config.topin.tech/create-assessment", { waitUntil: "domcontentloaded", timeout: 20000 });

      // ── Assessment name ──────────────────────────────────────
      broadcast("info", "Filling assessment name...");
      await pg.fill('input[placeholder="Enter Assessment Name"]', assessmentName);

      // ── Unique exam ID tag ───────────────────────────────────
      broadcast("info", "Adding exam ID tag...");
      const tagInput = pg.locator('[placeholder*="tag" i], [placeholder*="Tag"]').first();
      if (await tagInput.count()) {
        await tagInput.fill(uniqueExamId);
        await tagInput.press("Enter");
        await pg.waitForTimeout(500);
      }

      if (cancelRequested) { broadcast("info", "Cancelled"); return; }

      // ── Assessment dates ─────────────────────────────────────
      broadcast("info", "Setting assessment date and time...");
      await setDateTimeField(pg, "start", assessmentDate, startTime);
      await setDateTimeField(pg, "end",   assessmentDate, endTime);

      // ── Exam environment ─────────────────────────────────────
      broadcast("info", "Configuring exam environment settings...");
      // Exit PIN
      const exitPinField = pg.locator('[data-testid="ao-exam-environment-option"] input, input[placeholder*="PIN" i]').first();
      if (await exitPinField.count()) {
        await exitPinField.fill(exitPin);
      }
      // QR-based attendance
      const qrToggle = pg.locator('text=/QR.*attendance/i >> .. >> input[type="checkbox"]').first();
      if (await qrToggle.count() && !(await qrToggle.isChecked())) await qrToggle.check();
      // Common Start PIN
      const pinToggle = pg.locator('text=/Common Start PIN/i >> .. >> input[type="checkbox"]').first();
      if (await pinToggle.count() && !(await pinToggle.isChecked())) await pinToggle.check();

      if (cancelRequested) { broadcast("info", "Cancelled"); return; }

      // ── Publish ──────────────────────────────────────────────
      broadcast("info", "Clicking Publish Assessment...");
      await pg.click('button:has-text("publish assessment")', { timeout: 10000 });
      await pg.waitForTimeout(1000);

      // Select access type
      const accessBtn = pg.locator(`button:has-text("${accessType}")`).first();
      if (await accessBtn.count()) await accessBtn.click();

      const agreeBtn = pg.locator('button:has-text("Yes, I agree")').first();
      if (await agreeBtn.count()) await agreeBtn.click();

      await pg.waitForTimeout(2000);

      // ── Extract assessment link ──────────────────────────────
      broadcast("info", "Extracting assessment link...");
      let assessmentLink = "";
      try {
        assessmentLink = await pg.evaluate(() => navigator.clipboard.readText());
      } catch {
        const linkInput = pg.locator('input[value*="org_id="]').first();
        if (await linkInput.count()) assessmentLink = await linkInput.inputValue();
      }

      // Extract assessment ID from URL
      const urlMatch = pg.url().match(/\/(?:edit|view)-assessment\/([0-9a-f-]{36})/i);
      const assessmentId = urlMatch ? urlMatch[1] : "";

      await ctx.storageState({ path: SESSION_FILE });
      broadcast("done", "Assessment published successfully on Topin ✓", { assessmentLink, assessmentId });

    } catch (e) {
      broadcast("error", `Publish failed: ${e.message}`);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      jobRunning = false;
    }
  })();
});

// ── Cancel running job ────────────────────────────────────────
app.post("/api/publish/cancel", (_req, res) => {
  cancelRequested = true;
  broadcast("info", "Cancellation requested...");
  res.json({ status: "cancelling" });
});

// ── Date-time helper (Topin custom date picker) ───────────────
async function setDateTimeField(pg, field, dateStr, timeStr) {
  // Date pickers vary by Topin version — adapt selectors as needed
  const [yyyy, mm, dd] = dateStr.split("-");
  const [hh, min]      = timeStr.split(":");

  const dateInput = pg.locator(`[data-field="${field}-date"] input, input[name="${field}Date"]`).first();
  if (await dateInput.count()) {
    await dateInput.fill(`${mm}/${dd}/${yyyy}`);
  }
  const timeInput = pg.locator(`[data-field="${field}-time"] input, input[name="${field}Time"]`).first();
  if (await timeInput.count()) {
    await timeInput.fill(`${hh}:${min}`);
  }
}

app.listen(PORT, () => {
  console.log("─────────────────────────────────────────────");
  console.log(`  IOE Portal Automation Server`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  Health:     http://localhost:${PORT}/api/health`);
  console.log("  Set this URL in the portal's Credentials tab");
  console.log("─────────────────────────────────────────────");
});
