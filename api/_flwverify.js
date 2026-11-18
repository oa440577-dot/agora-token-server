const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();
const ORIGINS = ["https://stress-ochre.vercel.app", "http://localhost:5173"];

module.exports = async function handleVerify(req, res) {
  const o = req.headers.origin;
  if (ORIGINS.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const h = String(req.headers.authorization || "");
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return res.status(401).json({ error: "Please sign in." });
  let uid;
  try { uid = (await getAuth().verifyIdToken(tok)).uid; }
  catch (e) { return res.status(401).json({ error: "Please sign in again." }); }
  const body = req.body || {};
  const txRef = String(body.tx_ref || "");
  const id = String(body.transaction_id || "");
  if (!txRef || !/^\d+$/.test(id)) return res.status(400).json({ error: "Missing payment details." });
  try {
    const refDoc = db.collection("flwRefs").doc(txRef);
    const snap = await refDoc.get();
    if (!snap.exists) return res.status(404).json({ error: "Unknown payment." });
    const saved = snap.data();
    if (saved.uid !== uid) return res.status(403).json({ error: "Not your payment." });
    if (saved.status === "paid" || saved.status === "done") return res.status(200).json({ status: "paid", coins: Number(saved.coins) });
    const r = await fetch("https://api.flutterwave.com/v3/transactions/" + id + "/verify", {
      headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY }
    });
    const check = await r.json().catch(() => ({}));
    const v = check && check.data ? check.data : {};
    const ok = check.status === "success" && v.status === "successful" && v.tx_ref === txRef &&
      v.currency === saved.currency && Number(v.amount) >= Number(saved.amount);
    if (!ok) return res.status(200).json({ status: "not_confirmed" });
    const coins = Number(saved.coins);
    const walletRef = db.collection("wallets").doc(uid);
    const txDoc = db.collection("users").doc(uid).collection("transactions").doc(txRef);
    await db.runTransaction(async (t) => {
      const fresh = await t.get(refDoc);
      if (["paid", "done"].includes(fresh.data().status)) return;
      const w = await t.get(walletRef);
      const bal = w.exists ? w.data().coinBalance || 0 : 0;
      t.set(walletRef, { coinBalance: Math.round((bal + coins) * 100) / 100 }, { merge: true });
      t.set(txDoc, { type: "purchase", amount: coins, amountUsd: coins, provider: "flutterwave", flwRef: txRef, paidCurrency: saved.currency, paidAmount: Number(v.amount), createdAt: FieldValue.serverTimestamp() });
      t.update(refDoc, { status: "paid", paidAt: FieldValue.serverTimestamp() });
    });
    return res.status(200).json({ status: "paid", coins: coins });
  } catch (e) {
    console.error("flw verify:", e.message);
    return res.status(500).json({ error: "Confirm failed: " + String(e.message).slice(0, 140) });
  }
};
