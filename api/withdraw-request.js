const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { checkPin } = require("./_pin");

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

const COIN_USD = 1;
const CREATOR_SHARE = 0.8;
const MIN_COINS = 5;
const MAX_COINS = 5000;
const round2 = (n) => Math.round(n * 100) / 100;

const COUNTRIES = (
  "AL AM AT BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU " +
  "MT MD MC MK NO PL PT RO SM RS SK SI ES SE CH TR GB US CA MX BS CR DO " +
  "SV GT JM PA LC TT AG EC GY PE DZ BJ BW CI EG ET GM KE MG MU MA MZ NA " +
  "RW SN ZA TZ TN BH IL JO KW OM QA AE AU NZ BT BN HK IN ID JP MY MN PK " +
  "PH SG LK TW TH UZ VN NG"
).split(" ");

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
    const coins = Number(b.coins);
    if (round2(coins) !== coins || coins < MIN_COINS || coins > MAX_COINS) {
      return res.status(400).json({ error: "Enter " + MIN_COINS + " to " + MAX_COINS + " coins" });
    }
    const country = String(b.country || "").toUpperCase();
    if (!COUNTRIES.includes(country)) {
      return res.status(400).json({ error: "Withdrawals are not available in your country yet" });
    }
    const holder = String(b.holder || "").trim().slice(0, 100);
    const details = String(b.details || "").trim().slice(0, 200);
    if (holder.length < 2 || details.length < 5) {
      return res.status(400).json({ error: "Enter your full name and bank details" });
    }
    const pin = await checkPin(db, uid, String(b.pin || ""));
    if (!pin.ok) {
      const msg =
        pin.code === "NO_PIN" ? "Set your 5-digit PIN in Wallet first"
        : pin.code === "LOCKED" ? "Too many tries. Try again in 30 minutes."
        : "Wrong PIN. " + pin.left + " tries left";
      return res.status(400).json({ error: msg });
    }
    const grossUsd = round2(coins * COIN_USD);
    const payoutUsd = round2(grossUsd * CREATOR_SHARE);
    const walletRef = db.collection("wallets").doc(uid);
    const wdRef = db.collection("withdrawals").doc();
    await db.runTransaction(async (t) => {
      const w = await t.get(walletRef);
      const bal = w.exists ? w.data().coinBalance || 0 : 0;
      if (bal < coins) throw new Error("NOT_ENOUGH_COINS");
      t.set(walletRef, { coinBalance: round2(bal - coins) }, { merge: true });
      t.set(wdRef, { uid, coins, grossUsd, payoutUsd, country, holder, details, status: "pending", createdAt: FieldValue.serverTimestamp() });
    });
    await db.collection("users").doc(uid).collection("transactions").add({
      type: "withdrawal", amount: coins, payoutUsd, status: "pending", createdAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ ok: true, payoutUsd });
  } catch (err) {
    if (err.message === "NOT_ENOUGH_COINS") return res.status(400).json({ error: "Not enough coins" });
    console.error("withdraw-request failed:", err.message);
    return res.status(500).json({ error: "Withdrawal failed" });
  }
};
