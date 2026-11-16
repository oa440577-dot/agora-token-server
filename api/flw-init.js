const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();
const NGN_PER_USD = 1600;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const body = req.body || {};
    const coins = Number(body.amountUsd);
    const uid = String(body.uid || "");
    if (!uid || !(coins >= 1 && coins <= 5000) || Math.round(coins) !== coins) {
      return res.status(400).json({ error: "Choose an amount from 1 to 5000." });
    }
    const user = await getAuth().getUser(uid);
    if (!user.email) return res.status(400).json({ error: "Your account has no email." });
    const txRef = "stress_" + uid.slice(0, 8) + "_" + Date.now();
    const amountNgn = coins * NGN_PER_USD;
    await db.collection("flwRefs").doc(txRef).set({ uid, coins, amountNgn, status: "pending", createdAt: FieldValue.serverTimestamp() });
    const r = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: amountNgn,
        currency: "NGN",
        redirect_url: "https://stress-ochre.vercel.app/",
        customer: { email: user.email, name: user.displayName || "STRESS user" },
        customizations: { title: "STRESS coins", description: coins + " coins" },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.status !== "success" || !d.data || !d.data.link) {
      return res.status(502).json({ error: d.message || "Could not start the payment." });
    }
    return res.status(200).json({ url: d.data.link, reference: txRef });
  } catch (err) {
    console.error("flw-init failed:", err.message);
    return res.status(500).json({ error: "Could not start the payment." });
  }
};
