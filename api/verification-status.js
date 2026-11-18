const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Sign in first" });
    const { uid } = await getAuth().verifyIdToken(token);

    if (uid === process.env.STRESS_FOUNDER_UID) {
      return res.status(200).json({ verified: true, founder: true, permanent: true });
    }

    const snap = await db.collection("verificationSubscriptions").doc(uid).get();
    const data = snap.exists ? snap.data() : {};
    const expiry = data.expiresAt?.toDate?.() || null;
    const active = data.verified === true && expiry && expiry.getTime() > Date.now();
    if (active) await db.collection("verifiedUsers").doc(uid).set({ expiresAt: data.expiresAt }, { merge: true });

    return res.status(200).json({
      verified: Boolean(active),
      founder: false,
      expiresAt: expiry ? expiry.toISOString() : null,
      cancelled: data.cancelled === true
    });
  } catch (err) {
    console.error("verification status:", err.message);
    return res.status(401).json({ error: "Could not check verification" });
  }
};
