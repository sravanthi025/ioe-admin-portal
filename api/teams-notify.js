// POST /api/teams-notify
// Sends an SLA breach (or escalation) card to a Microsoft Teams channel
// Requires TEAMS_WEBHOOK_URL env var set in Vercel

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  if (!process.env.TEAMS_WEBHOOK_URL) {
    return res.status(503).json({ ok: false, error: "TEAMS_WEBHOOK_URL not configured in Vercel environment variables." });
  }

  const { assessment, stage, team, deadline, detectedAt, portalUrl, isEscalation, hoursPassed } = req.body || {};

  const title = isEscalation
    ? `Escalation: SLA Still Breached — ${Math.round((hoursPassed || 0))}h Overdue`
    : "SLA Breach Detected";

  const themeColor = isEscalation ? "7C3AED" : "C94040";

  const facts = [
    { name: "Assessment",       value: assessment || "—" },
    { name: "Stage",            value: stage      || "—" },
    { name: "Responsible Team", value: team       || "—" },
    { name: "Deadline",         value: deadline   || "—" },
    { name: "Detected At",      value: detectedAt || "—" },
  ];

  if (isEscalation && hoursPassed) {
    facts.push({ name: "Hours Overdue", value: `${(Math.round(hoursPassed * 10) / 10)} hours` });
  }

  const payload = {
    "@type":    "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor,
    summary: `${title} — ${assessment}`,
    sections: [{
      activityTitle:    `**${title}**`,
      activitySubtitle: `${stage} — ${assessment}`,
      markdown: true,
      facts,
      potentialAction: [{
        "@type": "OpenUri",
        name: "Open IOE Admin Portal",
        targets: [{ os: "default", uri: portalUrl || "https://ioe-admin-portal.vercel.app" }]
      }]
    }]
  };

  try {
    const r = await fetch(process.env.TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: `Teams returned ${r.status}: ${text}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
