const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();
const NGN_PER_USD = 1600;
const CUR = { NG: "NGN", GH: "GHS", KE: "KES", ZA: "ZAR", UG: "UGX", TZ: "TZS", RW: "RWF", GB: "GBP" };
const EURO = new Set(["AT", "BE", "CY", "EE", "FI", "FR", "DE", "GR", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES", "HR"]);
let cache = { at: 0, rates: null };

async function rates() {
  if (cache.rates && Date.now() - cache.at < 6 * 3600 * 1000) return cache.rates;
  const r = await fetch("https://open.er-api.com/v6/latest/USD");
  const d = await r.json();
  if (!r.ok || d.result !== "success" || !d.rates) throw new Error("no rates");
  cache = { at: Date.now(), rates: d.rates };
  return d.rates;
}

async function priceFor(country, coins) {
  const cc = String(country || "").toUpperCase();
  const cur = CUR[cc] || (EURO.has(cc) ? "EUR" : "USD");
  if (cur === "NGN") return { currency: "NGN", amount: coins * NGN_PER_USD };
  if (cur === "USD") return { currency: "USD", amount: coins };
  try {
    const rt = (await rates())[cur];
    if (!(rt > 0)) throw new Error("no rate");
    const raw = coins * rt;
    const amount = cur === "EUR" || cur === "GBP" ? Math.ceil(raw * 100) / 100 : Math.ceil(raw);
    return { currency: cur, amount };
  } catch (e) {
    return { currency: "USD", amount: coins };
  }
}

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
    const prof = await db.collection("users").doc(uid).get();
    const country = (prof.exists && prof.data().country) || String(body.guess || "");
    const { currency, amount } = await priceFor(country, coins);
    const txRef = "stress_" + uid.slice(0, 8) + "_" + Date.now();
    await db.collection("flwRefs").doc(txRef).set({ uid, coins, currency, amount, status: "pending", createdAt: FieldValue.serverTimestamp() });
    const r = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency,
        redirect_url: "https://stress-ochre.vercel.app/",
        customer: { email: user.email, name: user.displayName || "STRESS user" },
        customizations: { title: "STRESS coins", description: coins + " coins" },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.status !== "success" || !d.data || !d.data.link) {
      return res.status(502).json({ error: d.message || "Could not start the payment." });
    }
    return res.status(200).json({ url: d.data.link, reference: txRef, currency, amount });
  } catch (err) {
    console.error("flw-init failed:", err.message);
    return res.status(500).json({ error: "Could not start the payment." });
  }
};
