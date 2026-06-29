// Vercel serverless function — proxies student invite API calls in batches with retry logic
// POST /api/invite
// Body: { apiEndpoint, apiToken, candidates: [uid, ...], assessmentId }

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { apiEndpoint, apiToken, candidates, assessmentId } = req.body || {};

  if (!apiEndpoint || !apiToken || !Array.isArray(candidates) || !assessmentId) {
    return res.status(400).json({
      error: "Missing required fields: apiEndpoint, apiToken, candidates[], assessmentId"
    });
  }

  const BATCH_SIZE = 20;
  const results = { total: candidates.length, sent: 0, failed: 0, batches: [], errors: [] };

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    let success = false;

    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      try {
        const resp = await fetch(apiEndpoint, {
          method: "POST",
          headers: { "X-API-KEY": apiToken, "Content-Type": "application/json" },
          body: JSON.stringify({ candidate_user_ids: batch, assessment_id: assessmentId })
        });
        if (resp.ok) {
          results.sent += batch.length;
          results.batches.push({ batch: batchNum, status: "sent", count: batch.length });
          success = true;
        } else if (attempt === 2) {
          const errText = await resp.text().catch(() => resp.status.toString());
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
