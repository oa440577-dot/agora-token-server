const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { creditPayment } = require("./_flw");

if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

const db = getFirestore();
const ORIGINS = [
  "https://stress-ochre.vercel.app",
  "http://localhost:5173"
];

module.exports = async function handleVerify(req, res) {
  const origin = req.headers.origin;

  if (ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Please sign in." });
  }

  let uid;

  try {
    uid = (await getAuth().verifyIdToken(token)).uid;
  } catch (e) {
    return res.status(401).json({ error: "Please sign in again." });
  }

  const body = req.body || {};
  const txRef = String(body.tx_ref || "");
  const transactionId = String(body.transaction_id || "");

  if (
    !txRef.startsWith("stress_") ||
    txRef.startsWith("stress_verified_") ||
    !/^\d+$/.test(transactionId)
  ) {
    return res.status(400).json({ error: "Invalid payment details." });
  }

  try {
    const refDoc = db.collection("flwRefs").doc(txRef);
    const snap = await refDoc.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Unknown payment." });
    }

    if (snap.data().uid !== uid) {
      return res.status(403).json({ error: "Not your payment." });
    }

    const out = await creditPayment(db, txRef, transactionId);

    if (!out.ok) {
      return res.status(200).json({ status: "not_confirmed" });
    }

    return res.status(200).json({
      status: "paid",
      coins: out.coins
    });
  } catch (e) {
    console.error("flw verify:", e.message);
    return res.status(500).json({
      error: "Confirm failed: " + String(e.message).slice(0, 140)
    });
  }
};
