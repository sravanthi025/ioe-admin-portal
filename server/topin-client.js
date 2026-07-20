"use strict";
const fs   = require("fs");
const path = require("path");

const TOKEN_FILE = path.join(__dirname, "topin-tokens.json");

const SEB_XML = (() => {
  try { return fs.readFileSync(path.join(__dirname, "seb-template.xml"), "utf8"); } catch { return ""; }
})();

const INVITE_EMAIL_HTML = (() => {
  try { return fs.readFileSync(path.join(__dirname, "invite-email-template.html"), "utf8"); } catch { return ""; }
})();

const IB_API    = "https://ib-user-accounts-backend-prod-apis.ccbp.in";
const TOPIN_API = "https://nxtwave-assessments-backend-topin-prod-apis.ccbp.in";
const GRAPHQL   = "https://topin-config-prod-apis.ccbp.in/v1/graphql/";

const NIAT_ORG = {
  org_id:      "c6ec8dcb-d4e0-46e5-8123-f33974646b94",
  name:        "NIAT",
  logo_url:    "https://ezexam-mum.s3.ap-south-1.amazonaws.com/static_root/img/custom/niatadmissiontest-logotext-2.png",
  description: "",
};

const INSTRUCTIONS = [
  "Check the assessment time carefully. You can <b>only take the assessment at the times mentioned.</b>",
  "Be ready with your fully charged laptop/computer 5-10 minutes before the assessment starts.",
  "<b>You cannot take the assessment on a mobile or tablet.</b>",
  "Before the assessment, make sure notifications on your laptop/computer are turned off, other devices are silenced, and <b>all unnecessary tabs/windows are closed</b>.",
  "<b>Use Google Chrome for the assessment</b>. Other browsers may cause problems.",
  "Take the assessment in a <b>well-lit area</b> for better proctoring.",
  "During the assessment, don't cheat or use calculator, phone, or electronic devices. Also, <b>don't switch between different tabs on your computer</b> because the assessment is being monitored.",
  "<b>If you switch tabs, your assessment will be terminated, and you won't be allowed to attempt it again.</b>",
  "You'll find the WhatsApp icon at the bottom-right corner of the screen. Feel free to contact us if you have any technical problems.",
].join("\n");

const INTEGRITY_CONFIG = {
  is_pin_required:                true,
  enable_face_authentication:     true,
  assess_pin_mode:                "ORGANISATION_PIN",
  enable_periodic_pin_validation: true,
};

// ── Token management ──────────────────────────────────────────
function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch { return {}; }
}

function saveTokens(partial) {
  const existing = loadTokens();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, ...partial }, null, 2));
}

// ── Exit PIN generator ────────────────────────────────────────
const PIN_CHARS = "ACDEFGHJKLMNPQRTUVWXYZ23456789";
function generateExitPin(len = 6) {
  let pin = "";
  for (let i = 0; i < len; i++) pin += PIN_CHARS[Math.floor(Math.random() * PIN_CHARS.length)];
  return pin;
}

// ── Tag generation ────────────────────────────────────────────
function normBatch(b) {
  const num = String(b).replace(/^B/i, "").replace(/\D/g, "");
  return `B${num}`;
}
function normWeek(w) {
  const num = String(w).replace(/^W/i, "").replace(/\D/g, "");
  return `W${num}`;
}
function normDomain(d) {
  const s = String(d || "").toUpperCase();
  if (s.includes("JAVA")) return "JAVA";
  return "PYTHON";
}
function normPhase(p) {
  return String(p).replace(/^P/i, "").replace(/\D/g, "");
}

function generateExamTag(phase, batch, week, isMock, domain, p4SubType) {
  const p   = normPhase(phase);
  const b   = normBatch(batch);
  const w   = normWeek(week);
  const d   = normDomain(domain);
  const sub = (p4SubType || "weekly").toLowerCase();

  if (p === "1") {
    return isMock
      ? `IO26_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT_${b}_${w}`
      : `IO26_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT_${b}_${w}`;
  }
  if (p === "2") {
    return isMock
      ? `IO26BM_INTENSIVE_OFFLINE_MOCK_NXTMOCK_${b}_${w}`
      : `IO26BM_INTENSIVE_OFFLINE_MAIN_ASSESSMENT_${b}_${w}`;
  }
  if (p === "3") {
    if (d === "JAVA") {
      return isMock
        ? `IO26_P3_INTENSIVE_OFFLINE_MOCK_INTERVIEW_JAVA_${b}_${w}`
        : `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT_JAVA_${b}_${w}`;
    }
    return isMock
      ? `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT_PYTHON_${b}_${w}`
      : `IO26_P3_INTENSIVE_OFFLINE_MAIN_INTERVIEW_PYTHON_${b}_${w}`;
  }
  if (p === "4") {
    if (sub === "nxtmock")     return `IO26BM_P4_INTENSIVE_OFFLINE_MOCK_NXTMOCK_${d}_${b}`;
    if (sub === "nxtmock_tr1") return `IO26BM_P4_INTENSIVE_OFFLINE_MAIN_NXTMOCK_${d}_TR1_${b}`;
    if (sub === "nxtmock_tr2") return `IO26BM_P4_INTENSIVE_OFFLINE_MAIN_NXTMOCK_${d}_TR2_${b}`;
    // "weekly" (default)
    return isMock
      ? `IO26BM_P4_INTENSIVE_OFFLINE_MOCK_ASSESSMENT_${d}_${b}_${w}`
      : `IO26BM_P4_INTENSIVE_OFFLINE_MAIN_ASSESSMENT_${d}_${b}_${w}`;
  }
  return `IOE_P${p}_${isMock ? "MOCK" : "MAIN"}_${b}_${w}`;
}

// ── Double-encode for Topin API body ──────────────────────────
function topinBody(innerData) {
  return JSON.stringify({
    data:               JSON.stringify(JSON.stringify(innerData)),
    clientKeyDetailsId: 1,
  });
}

// ── IB code → Topin token exchange ───────────────────────────
async function ibCodeToTopinToken(ibAccessToken) {
  const codeRes = await fetch(`${IB_API}/api/ib_user_accounts/code/v1/`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${ibAccessToken}`, "Content-Type": "application/json" },
    body:    topinBody({ client_id: "topin" }),
  });
  if (!codeRes.ok) throw new Error(`IB code/v1 ${codeRes.status}`);
  const { code } = await codeRes.json();

  const tokRes = await fetch(`${TOPIN_API}/api/nw_auth/login/auth_code/v2/`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    topinBody({ code }),
  });
  if (!tokRes.ok) throw new Error(`auth_code/v2 ${tokRes.status}`);
  return tokRes.json();
}

// ── Token refresh chain (3 levels) ───────────────────────────
async function getValidTopinToken(broadcast) {
  const bcast = broadcast || (() => {});
  const t     = loadTokens();
  const now   = Date.now();
  const BUF   = 5 * 60 * 1000;

  if (t.topin_access_token && (t.topin_expires_at || 0) - now > BUF) {
    return t.topin_access_token;
  }

  bcast("info", "[AUTH] Topin token expired — trying IB token...");

  if (t.ib_access_token && (t.ib_expires_at || 0) - now > BUF) {
    try {
      const tok = await ibCodeToTopinToken(t.ib_access_token);
      const exp = Date.now() + parseFloat(tok.expires_in || 3600) * 1000;
      saveTokens({ topin_access_token: tok.access_token, topin_refresh_token: tok.refresh_token || "", topin_expires_at: exp });
      bcast("info", "[AUTH] Topin token refreshed via IB access token.");
      return tok.access_token;
    } catch (e) {
      bcast("info", `[AUTH] IB token exchange failed: ${e.message}`);
    }
  }

  if (t.ib_refresh_token) {
    try {
      bcast("info", "[AUTH] Refreshing IB session token...");
      const ibRes = await fetch(`${IB_API}/api/ib_user_accounts/token/refresh/v1/`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    topinBody({ refresh_token: t.ib_refresh_token }),
      });
      if (!ibRes.ok) throw new Error(`IB refresh ${ibRes.status}`);
      const ibData = await ibRes.json();
      saveTokens({ ib_access_token: ibData.access_token, ib_refresh_token: ibData.refresh_token || t.ib_refresh_token, ib_expires_at: Date.now() + (ibData.expires_in || 3600) * 1000 });
      const tok = await ibCodeToTopinToken(ibData.access_token);
      const exp = Date.now() + parseFloat(tok.expires_in || 3600) * 1000;
      saveTokens({ topin_access_token: tok.access_token, topin_refresh_token: tok.refresh_token || "", topin_expires_at: exp });
      bcast("info", "[AUTH] Topin token refreshed via IB refresh token.");
      return tok.access_token;
    } catch (e) {
      bcast("info", `[AUTH] All auto-refresh levels failed: ${e.message}`);
    }
  }

  return null;
}

// ── Get/cache Topin user + org IDs ───────────────────────────
async function getProfile(accessToken) {
  const t = loadTokens();
  if (t.topin_user_id && t.topin_org_id) return { user_id: t.topin_user_id, org_id: t.topin_org_id };

  const res = await fetch(`${TOPIN_API}/api/nw_auth/user/profile/v1/`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`profile/v1 ${res.status}`);
  const data    = await res.json();
  const user_id = data.user_id;
  const org_id  = data.organisation_details?.org_id;
  saveTokens({ topin_user_id: user_id, topin_org_id: org_id });
  return { user_id, org_id };
}

// ── Extract UUID from Topin config URL ────────────────────────
function extractConfigUuid(url) {
  const m = (url || "").match(/\/(?:edit|view)-assessment\/([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Cannot extract config UUID from URL: ${url}`);
  return m[1];
}

// ── Build assessData and call Topin publish API ───────────────
async function publishAssessment(accessToken, opts) {
  const { configUrl, title, startDatetime, endDatetime, exitPin, uniqueExamId, isSEB = true } = opts;
  const configId = extractConfigUuid(configUrl);

  const tags = [
    "SHOW_SCORE_ON_LEVEL_COMPLETION",
    "HIDE_WHATSAPP_ICON",
    "DISABLE_CAMERA_PROCTORING_WARNING",
    uniqueExamId,
  ];
  if (isSEB) tags.push("IS_SEB_EXAM");

  const sebPart = (isSEB && SEB_XML) ? {
    seb_config:       { seb_file_content_str: SEB_XML, custom_exit_password: exitPin },
    integrity_config: INTEGRITY_CONFIG,
  } : {};

  const assessData = {
    organisation_details: NIAT_ORG,
    org_assessment_details: {
      title,
      description:      "",
      instructions_str: INSTRUCTIONS,
      start_datetime:   startDatetime,
      end_datetime:     endDatetime,
      selection_config: { min_score_to_qualify: null, no_of_users_to_qualify: null },
      event_config: {
        invite_email_template: {
          subject: `Invitation to GRIT Contest | ["assessment_title"]`,
          body:    INVITE_EMAIL_HTML || "",
        },
        remainder_email_template: null,
        send_on_complete_event:   false,
      },
      content_tags:          tags,
      access_config:         { is_public: false, admin_review_access_type: "PRIVATE" },
      custom_data_form_link: null,
      assessment_mode:       isSEB ? "SEB_BROWSER" : "BROWSER",
      user_check_in_enabled: true,
      check_in_mode:         "DURING_ASSESSMENT",
      ...sebPart,
    },
  };

  const innerData = {
    user_org_assess_config_id: configId,
    assess_data:               JSON.stringify(assessData),
  };

  const body = JSON.stringify({
    data:               JSON.stringify(JSON.stringify(innerData)),
    clientKeyDetailsId: 1,
  });

  const res = await fetch(`${TOPIN_API}/api/nw_assess_config/user/org_assess/publish/`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Topin publish API returned ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json().catch(() => ({}));
}

// ── Poll GraphQL for the published assessment ─────────────────
const FIND_QUERY = `
  query FindByTag($user_id: uuid!, $org_id: uuid!, $tag: String!) {
    user_assessment(
      where: {
        user_id:            { _eq: $user_id }
        org_id:             { _eq: $org_id }
        tags_str:           { _ilike: $tag }
        published_datetime: { _is_null: false }
      }
      order_by: { published_datetime: desc }
      limit: 1
    ) {
      id
      published_assess_id
      name
      published_datetime
    }
  }
`;

async function findPublishedAssessment(accessToken, userId, orgId, uniqueExamId, onPoll) {
  const delays = [2000, 3000, 4000, 5000, 5000, 5000, 5000];
  for (let i = 0; i < delays.length; i++) {
    await new Promise(r => setTimeout(r, delays[i]));
    if (onPoll) onPoll(i + 1, delays.length);
    try {
      const res = await fetch(GRAPHQL, {
        method:  "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          query:     FIND_QUERY,
          variables: { user_id: userId, org_id: orgId, tag: `%${uniqueExamId}%` },
        }),
      });
      const json = await res.json().catch(() => ({}));
      const rows = json?.data?.user_assessment || [];
      if (rows.length && rows[0].published_assess_id) return rows[0];
    } catch { /* retry */ }
  }
  return null;
}

function buildAssessmentLink(publishedAssessId) {
  return `https://assessment.topin.tech/?org_id=${publishedAssessId}&a_t=CLIENT`;
}

function formatDatetime(date, time) {
  // date: "2026-07-20", time: "10:00" → "2026-07-20 10:00:00"
  const t = String(time || "00:00");
  const normalised = t.includes(":") ? t : `${t.slice(0, 2)}:${t.slice(2)}`;
  return `${date} ${normalised.padStart(5, "0")}:00`;
}

module.exports = {
  loadTokens,
  saveTokens,
  generateExitPin,
  generateExamTag,
  getValidTopinToken,
  getProfile,
  extractConfigUuid,
  publishAssessment,
  findPublishedAssessment,
  buildAssessmentLink,
  formatDatetime,
};
