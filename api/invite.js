// Vercel serverless function — proxies student invite calls to Topin invite API
// POST /api/invite
// Body: { candidates: [uid, ...], assessmentId }
// API key is stored in TOPIN_INVITE_API_KEY Vercel env var (never exposed to frontend)

export const config = { maxDuration: 60 };

const INVITE_ENDPOINT = "https://nxtwave-assessments-backend-topin-prod-apis.ccbp.in/api/nw_integrations/invite/assess/candidates/v2/";
const BATCH_SIZE = 20;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.TOPIN_INVITE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "TOPIN_INVITE_API_KEY is not set in Vercel environment variables." });
  }

  const { candidates, assessmentId } = req.body || {};

  if (!Array.isArray(candidates) || !candidates.length || !assessmentId) {
    return res.status(400).json({ error: "Missing required fields: candidates[], assessmentId" });
  }

  const results = { total: candidates.length, sent: 0, failed: 0, batches: [], errors: [] };

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch    = candidates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    let success    = false;

    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      try {
        const resp = await fetch(INVITE_ENDPOINT, {
          method:  "POST",
          headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
          body:    JSON.stringify({ candidate_user_ids: batch, assessment_id: assessmentId }),
        });
        if (resp.ok) {
          results.sent += batch.length;
          results.batches.push({ batch: batchNum, status: "sent", count: batch.length });
          success = true;
        } else if (attempt === 2) {
          const errText = await resp.text().catch(() => String(resp.status));
          results.failed += batch.length;
          results.batches.push({ batch: batchNum, status: "failed", count: batch.length, error: `HTTP ${resp.status}: ${errText}` });
          results.errors.push(`Batch ${batchNum}: HTTP ${resp.status} — ${errText}`);
        }
      } catch (e) {
        if (attempt === 2) {
          results.failed += batch.length;
          results.batches.push({ batch: batchNum, status: "failed", count: batch.length, error: e.message });
          results.errors.push(`Batch ${batchNum}: ${e.message}`);
        }
      }
    }

    if (i + BATCH_SIZE < candidates.length) await new Promise(r => setTimeout(r, 400));
  }

  return res.status(200).json(results);
}
