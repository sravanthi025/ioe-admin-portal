"use strict";
const fs           = require("fs");
const path         = require("path");
const express      = require("express");
const cors         = require("cors");
const { chromium } = require("playwright");
const topinClient  = require("./topin-client");
const topinClone   = require("./topin-clone");

const app  = express();
const PORT = process.env.PORT || 3001;
const BASE_URL     = "https://config.topin.tech/";
const SESSION_FILE = path.join(__dirname, "topin-session.json");

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── SSE broadcast ─────────────────────────────────────────────
const sseClients = new Set();
let jobRunning      = false;
let cancelRequested = false;
let browser         = null;
let pendingAuthCtx  = null;

function broadcast(type, message, extra = {}) {
  const payload = JSON.stringify({ type, message, ts: new Date().toISOString(), ...extra });
  sseClients.forEach(res => { try { res.write(`data: ${payload}\n\n`); } catch {} });
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ── Health ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ── Token status ──────────────────────────────────────────────
// Publishing now drives the real Topin UI via a saved browser session (cookies),
// not the JWT token pair. We can only confirm the session file exists here —
// whether it's still valid is checked for real when a publish actually runs.
app.get("/api/publish/token-status", (_req, res) => {
  const hasSession = fs.existsSync(SESSION_FILE);
  res.json({ hasValidToken: hasSession, hasTopin: hasSession, hasIB: false, hasRefresh: false, expiresIn: 0 });
});

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

// ── Browser helper ────────────────────────────────────────────
async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  }
  return browser;
}

// Restore the saved Topin browser session (cookies), if any, and confirm it's still
// logged in. Returns { page, context } or null if there's no session / it expired.
async function getAuthedPage(onLog = () => {}) {
  if (!fs.existsSync(SESSION_FILE)) return null;
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    if (page.url().includes("accounts.ccbp.in")) {
      onLog("Saved Topin session has expired.");
      await context.close().catch(() => {});
      return null;
    }
    return { page, context };
  } catch (e) {
    onLog(`Failed to restore saved Topin session: ${e.message}`);
    await context?.close().catch(() => {});
    return null;
  }
}

// ── Set up network interception to capture IB + Topin tokens ──
function setupTokenCapture(context) {
  context.on("response", async (response) => {
    try {
      const url = response.url();
      // IB OTP verify response → contains IB access_token
      if (url.includes("login_otp/verify/v1") || url.includes("mobile/otp/verify")) {
        const data = await response.json().catch(() => null);
        if (data?.access_token) {
          topinClient.saveTokens({
            ib_access_token:  data.access_token,
            ib_refresh_token: data.refresh_token || "",
            ib_expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
          });
          broadcast("info", "[AUTH] IB access token captured.");
        }
      }
      // Topin auth_code exchange → contains Topin access_token
      if (url.includes("auth_code/v2")) {
        const data = await response.json().catch(() => null);
        if (data?.access_token) {
          topinClient.saveTokens({
            topin_access_token:  data.access_token,
            topin_refresh_token: data.refresh_token || "",
            topin_expires_at:    Date.now() + parseFloat(data.expires_in || 3600) * 1000,
          });
          broadcast("info", "[AUTH] Topin access token captured — future publishes skip OTP.");
        }
      }
    } catch { /* non-fatal */ }
  });
}

// ── Step 1: Start OTP login ───────────────────────────────────
app.post("/api/publish/start", async (req, res) => {
  const { mobile } = req.body || {};
  if (!mobile) return res.status(400).json({ error: "mobile number required" });

  // Skip OTP entirely if the saved session is still valid
  const existing = await getAuthedPage(msg => broadcast("info", msg));
  if (existing) {
    await existing.context.close().catch(() => {});
    broadcast("info", "Already logged in — saved session is still valid.");
    return res.json({ status: "already_authenticated" });
  }

  try {
    broadcast("info", "Opening Topin login page...");
    const b = await ensureBrowser();
    if (pendingAuthCtx) { await pendingAuthCtx.close().catch(() => {}); pendingAuthCtx = null; }
    pendingAuthCtx = await b.newContext();
    setupTokenCapture(pendingAuthCtx);
    const pg = await pendingAuthCtx.newPage();

    await pg.goto("https://config.topin.tech/", { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!pg.url().includes("ccbp.in")) {
      await pg.waitForURL(u => u.href.includes("ccbp.in") || u.href.includes("login"), { timeout: 15000 }).catch(() => {});
    }
    await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    broadcast("info", `Login page ready: ${pg.url().split("?")[0]}`);

    const mobileInput = pg.locator([
      'input[placeholder="Enter Number"]',
      'input[placeholder*="mobile" i]',
      'input[placeholder*="phone" i]',
      'input[placeholder*="number" i]',
      'input[type="tel"]',
      'input[name*="mobile" i]',
    ].join(", ")).first();
    await mobileInput.waitFor({ state: "visible", timeout: 15000 });
    await mobileInput.fill(mobile);

    await pg.locator([
      'button:has-text("GET OTP")',
      'button:has-text("Get OTP")',
      'button:has-text("Send OTP")',
      'button:has-text("Continue")',
      'button[type="submit"]',
    ].join(", ")).first().click({ timeout: 10000 });

    broadcast("info", `OTP sent to ${mobile.replace(/\d(?=\d{4})/g, "*")}`);
    res.json({ status: "otp_sent" });
  } catch (e) {
    broadcast("error", `Login start failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 2: Verify OTP (token capture happens via setupTokenCapture) ──
app.post("/api/publish/verify-otp", async (req, res) => {
  const { otp } = req.body || {};
  if (!otp || String(otp).length !== 6) return res.status(400).json({ error: "6-digit OTP required" });
  if (!pendingAuthCtx) return res.status(400).json({ error: "No login in progress — call /start first" });

  try {
    const pages  = pendingAuthCtx.pages();
    const pg     = pages[pages.length - 1];
    const otpStr = String(otp);

    broadcast("info", "Waiting for OTP form...");
    await pg.waitForSelector('#verifyOtpButton, [data-testid="multi-step-verify-otp-button"]', { timeout: 15000 });
    await pg.waitForTimeout(600);

    const allVisible = await pg.locator("input:visible").all();
    broadcast("info", `Found ${allVisible.length} input(s) on OTP page`);

    if (allVisible.length > 0) {
      await allVisible[0].click();
      await pg.waitForTimeout(200);
      await allVisible[0].pressSequentially(otpStr, { delay: 120 });
    } else {
      throw new Error("No input fields on OTP page");
    }
    await pg.waitForTimeout(500);

    const btnDisabled = await pg.$eval(
      '#verifyOtpButton, [data-testid="multi-step-verify-otp-button"]',
      el => el.disabled
    ).catch(() => false);

    if (btnDisabled && allVisible.length >= 6) {
      broadcast("info", "Filling each OTP box individually...");
      for (let i = 0; i < 6; i++) {
        await allVisible[i].click();
        await allVisible[i].pressSequentially(otpStr[i], { delay: 80 });
        await pg.waitForTimeout(100);
      }
      await pg.waitForTimeout(400);
    }

    await pg.waitForSelector(
      '#verifyOtpButton:not([disabled]), [data-testid="multi-step-verify-otp-button"]:not([disabled])',
      { timeout: 8000 }
    ).catch(() => {});

    broadcast("info", "Clicking Verify...");
    await pg.click('#verifyOtpButton, [data-testid="multi-step-verify-otp-button"]', { timeout: 8000 })
      .catch(() => pg.getByRole("button", { name: /verify/i }).click({ timeout: 5000 }));

    await pg.waitForTimeout(2000);
    await pg.waitForURL(u => !u.href.includes("accounts.ccbp.in"), { timeout: 25000 }).catch(() => {});
    await pg.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    // Give React time to complete the auth_code exchange (token capture happens via response listener)
    await pg.waitForTimeout(3000);

    // Primary success check: tokens were captured by the response listener during auth exchange.
    // This is reliable even if Topin later redirects the browser back to the login page.
    const captured = topinClient.loadTokens();
    if (captured.topin_access_token || captured.ib_access_token) {
      await pendingAuthCtx.storageState({ path: SESSION_FILE }).catch(() => {});
      broadcast("success", "Logged in — session saved for future publishes");
      pendingAuthCtx = null;
      return res.json({ status: "authenticated" });
    }

    // Fallback URL check — catches genuine wrong-OTP / expired-OTP cases
    const currentUrl = pg.url();
    if (currentUrl.includes("accounts.ccbp.in") || currentUrl === "about:blank") {
      throw new Error("Still on login page — OTP may be incorrect or expired");
    }

    await pendingAuthCtx.storageState({ path: SESSION_FILE }).catch(() => {});
    broadcast("success", "Logged in — session saved for future publishes");
    pendingAuthCtx = null;
    res.json({ status: "authenticated" });
  } catch (e) {
    broadcast("error", `OTP verification failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 3: Publish by cloning the existing config in the real Topin UI ──
app.post("/api/publish/run", async (req, res) => {
  if (jobRunning) return res.status(409).json({ error: "A publish job is already running" });

  const {
    configUrl, title,
    assessmentDate, startTime, endTime,
    exitPin, uniqueExamId,
    isSEB = true, isMock = false,
  } = req.body || {};

  if (!configUrl || !title || !assessmentDate || !startTime || !endTime || !uniqueExamId || (isSEB && !exitPin)) {
    return res.status(400).json({ error: "Missing fields: configUrl, title, assessmentDate, startTime, endTime, uniqueExamId" + (isSEB ? ", exitPin" : "") });
  }

  const authed = await getAuthedPage(msg => broadcast("info", msg));
  if (!authed) {
    return res.status(401).json({ status: "needs_otp", error: "No valid Topin session — complete OTP login first" });
  }

  // Respond immediately so the browser isn't waiting; publish runs async
  res.json({ status: "started" });
  jobRunning = true; cancelRequested = false;

  (async () => {
    const { page, context } = authed;
    try {
      const label = isMock ? "Mock Assessment" : "Main Assessment";
      broadcast("info", `Starting clone-based publish: ${label}...`);

      const startDate = topinClone.buildDate(assessmentDate, startTime);
      const endDate    = topinClone.buildDate(assessmentDate, endTime);
      broadcast("info", `Schedule: ${startDate.toLocaleString()} → ${endDate.toLocaleString()}`);
      broadcast("info", `Tag: ${uniqueExamId}`);
      broadcast("info", `Mode: ${isSEB ? "SEB Browser" : "Normal Browser"}`);

      const result = await topinClone.cloneAndPublish(page, {
        sampleConfigLink: configUrl, title, uniqueExamId,
        startDate, endDate, exitPin, isSEB,
      }, msg => broadcast("info", msg));

      if (!result.assessmentLink) {
        // Clone + publish click succeeded, but the Copy Link button's clipboard read failed
        // (e.g. headless clipboard permissions). Fall back to the derived view-assessment URL.
        broadcast("info", "Could not read the link from clipboard — using the config URL as a fallback.");
      }

      broadcast("done", `${label} published successfully!`, {
        assessmentLink: result.assessmentLink,
        newConfigLink:  result.newConfigLink,
        exitPin, uniqueExamId, isMock,
      });
    } catch (e) {
      broadcast("error", `Publish failed: ${e.message}`);
    } finally {
      await context.close().catch(() => {});
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

app.listen(PORT, () => {
  console.log("─────────────────────────────────────────────");
  console.log(`  IOE Portal — Topin Direct API Server`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  Health:     http://localhost:${PORT}/api/health`);
  console.log(`  Tokens:     ${require("path").join(__dirname, "topin-tokens.json")}`);
  console.log("─────────────────────────────────────────────");
});
