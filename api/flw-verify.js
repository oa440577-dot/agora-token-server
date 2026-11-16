const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { creditPayment } = require("./_flw");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const uid = (await getAuth().verifyIdToken(token)).uid;
    const b = req.body || {};
    if (!b.txRef || !b.transactionId) return res.status(400).json({ error: "Missing payment details" });
    const snap = await db.collection("flwRefs").doc(String(b.txRef)).get();
    if (!snap.exists || snap.data().uid !== uid) return res.status(403).json({ error: "Not your payment" });
    const out = await creditPayment(db, b.txRef, b.transactionId);
    return res.status(out.ok ? 200 : 400).json({ ok: out.ok, coins: out.coins, error: out.reason });
  } catch (err) {
    console.error("flw-verify failed:", err.message);
    return res.status(500).json({ error: "Could not confirm the payment." });
  }
};
