// Vercel serverless function — reads IC Firebase interviews using Admin SDK
// GET /api/ic-interviews
// Requires IC_SERVICE_ACCOUNT env var in Vercel (service account JSON from Kiran)

export const config = { maxDuration: 30 };

let icDb = null;

async function getIcDb() {
  if (icDb) return icDb;
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore }                  = await import("firebase-admin/firestore");
  const existing = getApps().find(a => a.name === "ic");
  const sa  = JSON.parse(Buffer.from(process.env.IC_SA_B64, "base64").toString("utf8"));
  const app = existing || initializeApp({ credential: cert(sa) }, "ic");
  icDb = getFirestore(app);
  return icDb;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  if (!process.env.IC_SA_B64) {
    return res.status(503).json({
      ok: false,
      error: "IC_SA_B64 env var not set in Vercel."
    });
  }

  try {
    const db   = await getIcDb();
    // Filter server-side to Intensive Offline only
    const snap = await db.collection("interviews")
      .where("program", "==", "Intensive Offline")
      .get();
    const interviews = snap.docs.map(d => {
      const r = d.data();
      return {
        _id:              d.id,
        candidateName:    r.candidateName    || r.studentName   || "",
        candidateEmail:   r.candidateEmail   || r.studentEmail  || "",
        interviewerEmail: r.interviewerEmail || r.interviewerName || "",
        scheduledDate:    r.scheduledDate    || "",
        scheduledTime:    r.scheduledTime    || "",
        round:            r.round            || 1,
        status:           r.status          || "pending",
        program:          r.program          || "",
        templateName:     r.templateName     || "",
      };
    });
    res.json({ ok: true, count: interviews.length, interviews });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
