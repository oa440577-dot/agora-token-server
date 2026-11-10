const Stripe = require("stripe");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { checkPin } = require("./_pin");

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

const COIN_USD = 100;
const CREATOR_SHARE = 0.8;
const MIN_COINS = 0.1;
const MAX_COINS = 100;
const round2 = (n) => Math.round(n * 100) / 100;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  let uid = null;
  let wdRef = null;
  let deducted = false;
  let coins = 0;

  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not signed in" });
    uid = (await getAuth().verifyIdToken(token)).uid;

    coins = Number(req.body && req.body.coins);
    if (round2(coins) !== coins || coins < MIN_COINS || coins > MAX_COINS) {
      return res.status(400).json({
        error: "Enter an amount from " + MIN_COINS + " to " + MAX_COINS + " coins",
      });
    }

    const pinResult = await checkPin(db, uid, String((req.body && req.body.pin) || ""));
    if (!pinResult.ok) {
      const msg =
        pinResult.code === "NO_PIN" ? "Set your 5-digit PIN in Wallet first"
        : pinResult.code === "LOCKED" ? "Too many tries. Try again in 30 minutes."
        : "Wrong PIN. " + pinResult.left + " tries left";
      return res.status(400).json({ error: msg });
    }

    const connectSnap = await db.collection("connect").doc(uid).get();
    const accountId = connectSnap.exists ? connectSnap.data().accountId : null;
    if (!accountId) {
      return res.status(400).json({ error: "Connect your payout account first" });
    }

    const walletRef = db.collection("wallets").doc(uid);
    wdRef = db.collection("withdrawals").doc();
    const grossUsd = round2(coins * COIN_USD);
    const payoutCents = Math.round(grossUsd * CREATOR_SHARE * 100);

    await db.runTransaction(async (t) => {
      const w = await t.get(walletRef);
      const bal = w.exists ? w.data().coinBalance || 0 : 0;
      if (bal < coins) throw new Error("NOT_ENOUGH_COINS");
      t.set(walletRef, { coinBalance: round2(bal - coins) }, { merge: true });
      t.set(wdRef, {
        uid,
        accountId,
        coins,
        grossUsd,
        payoutCents,
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    deducted = true;

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const transfer = await stripe.transfers.create(
      {
        amount: payoutCents,
        currency: "usd",
        destination: accountId,
        metadata: { uid, withdrawalId: wdRef.id, coins: String(coins) },
      },
      { idempotencyKey: "wd_" + wdRef.id }
    );

    await wdRef.update({ status: "paid", transferId: transfer.id });
    await db.collection("users").doc(uid).collection("transactions").add({
      type: "withdrawal",
      amount: coins,
      payoutUsd: payoutCents / 100,
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ ok: true, payoutUsd: payoutCents / 100 });
  } catch (err) {
    if (err.message === "NOT_ENOUGH_COINS") {
      return res.status(400).json({ error: "Not enough coins" });
    }
    console.error("withdraw failed:", err.message);
    if (deducted && uid && wdRef) {
      try {
        const walletRef = db.collection("wallets").doc(uid);
        await db.runTransaction(async (t) => {
          const w = await t.get(walletRef);
          const bal = w.exists ? w.data().coinBalance || 0 : 0;
          t.set(walletRef, { coinBalance: round2(bal + coins) }, { merge: true });
          t.update(wdRef, { status: "failed", error: String(err.message).slice(0, 200) });
        });
      } catch (e2) {
        console.error("withdraw refund failed:", e2.message);
      }
    }
    return res.status(500).json({ error: "Withdrawal failed. Your coins were not taken." });
  }
};
