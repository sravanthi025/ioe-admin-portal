// POST /api/ic-request
// Writes interview schedule requests to IC Firestore → picked up by IC automation
// Requires IC_SA_B64 env var

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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ ok: false, error: "Method not allowed" });

  if (!process.env.IC_SA_B64) {
    return res.status(503).json({ ok: false, error: "IC_SA_B64 not set in Vercel environment." });
  }

  const { students, requestedDate, requestedBy } = req.body || {};
  if (!Array.isArray(students) || !students.length) {
    return res.status(400).json({ ok: false, error: "students array is required" });
  }
  if (!requestedDate) {
    return res.status(400).json({ ok: false, error: "requestedDate is required" });
  }

  try {
    const db = await getIcDb();
    const { FieldValue } = await import("firebase-admin/firestore");
    const batch = db.batch();

    for (const s of students) {
      const ref = db.collection("interview_requests").doc();
      batch.set(ref, {
        uid:            s.uid            || "",
        candidateName:  s.name           || "",
        candidateEmail: s.email          || "",
        phase:          s.phase          || "",
        batch:          s.batch          || "",
        week:           s.week           || "",
        requestedDate,
        status:         "pending",
        requestedAt:    FieldValue.serverTimestamp(),
        requestedBy:    requestedBy      || "",
        source:         "ioe-portal",
      });
    }

    await batch.commit();
    res.json({ ok: true, count: students.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
