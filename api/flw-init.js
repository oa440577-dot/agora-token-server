const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const PACKS = [10, 25, 50, 100, 250, 500, 1000, 2000, 3000];
const NGN_RATE = 1600;
const RETURN_URL = "https://stress-ochre.vercel.app/wallet?success=true";

const CURRENCY_BY_COUNTRY = {
  ng: "NGN", nigeria: "NGN",
  gh: "GHS", ghana: "GHS",
  ke: "KES", kenya: "KES",
  za: "ZAR", "south africa": "ZAR",
  ug: "UGX", uganda: "UGX",
  tz: "TZS", tanzania: "TZS",
  rw: "RWF", rwanda: "RWF",
  gb: "GBP", uk: "GBP", "united kingdom": "GBP",
};
const ZERO_DECIMAL = ["UGX", "RWF", "XOF", "XAF"];

async function getRate(cur) {
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(4000),
    });
    const j = await r.json();
    const rate = j && j.rates ? Number(j.rates[cur]) : 0;
    return rate > 0 ? rate : null;
  } catch (e) {
    return null;
  }
}

async function pickCharge(country, coins) {
  const key = String(country || "").trim().toLowerCase();
  const cur = CURRENCY_BY_COUNTRY[key] || "USD";
  if (cur === "NGN") return { currency: "NGN", amount: coins * NGN_RATE };
  if (cur === "USD") return { currency: "USD", amount: coins };
  const rate = await getRate(cur);
  if (!rate) return { currency: "USD", amount: coins };
  const raw = coins * rate;
  const amount = ZERO_DECIMAL.includes(cur) ? Math.ceil(raw) : Math.ceil(raw * 100) / 100;
  return { currency: cur, amount };
}

async function createLink(secret, body) {
  const r = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

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
    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const coins = Number(req.body && req.body.coins);
    if (!PACKS.includes(coins)) return res.status(400).json({ error: "Invalid coin pack" });

    const userDoc = await db.collection("users").doc(uid).get();
    const profile = userDoc.exists ? userDoc.data() : {};
    const country = profile.country || (req.body && req.body.country) || "";

    let charge = await pickCharge(country, coins);
    const ref = "stress_" + uid.slice(0, 8) + "_" + Date.now();
    const secret = process.env.FLW_SECRET_KEY;

    const build = (c) => ({
      tx_ref: ref,
      amount: c.amount,
      currency: c.currency,
      redirect_url: RETURN_URL,
      customer: { email: decoded.email || "", name: profile.name || "STRESS user" },
      customizations: { title: "STRESS", description: coins + " coins" },
      meta: { uid: uid, coins: coins },
    });

    let out = await createLink(secret, build(charge));
    if ((!out || out.status !== "success") && charge.currency !== "USD") {
      charge = { currency: "USD", amount: coins };
      out = await createLink(secret, build(charge));
    }
    if (!out || out.status !== "success" || !out.data || !out.data.link) {
      console.error("Flutterwave init failed:", JSON.stringify(out));
      return res.status(502).json({ error: "Could not start payment" });
    }

    await db.collection("flwRefs").doc(ref).set({
      uid: uid,
      coins: coins,
      currency: charge.currency,
      amount: charge.amount,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ url: out.data.link, currency: charge.currency, amount: charge.amount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to start payment" });
  }
};
