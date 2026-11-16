const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();

async function verifyWithFlutterwave(id) {
  const r = await fetch("https://api.flutterwave.com/v3/transactions/" + id + "/verify", {
    headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY },
  });
  return r.json().catch(() => ({}));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const hash = req.headers["verif-hash"];
  if (!(process.env.FLW_WEBHOOK_SECRET_HASH || process.env.FLW_SECRET_HASH) || hash !== (process.env.FLW_WEBHOOK_SECRET_HASH || process.env.FLW_SECRET_HASH)) {
    return res.status(401).send("Invalid signature");
  }

  try {
    const event = req.body || {};
    const data = event.data || {};
    if (event.event !== "charge.completed" || data.status !== "successful" || !data.id || !data.tx_ref) {
      return res.status(200).json({ ignored: true });
    }

    const refDoc = db.collection("flwRefs").doc(String(data.tx_ref));
    const snap = await refDoc.get();
    if (!snap.exists) return res.status(200).json({ ignored: "unknown ref" });
    const saved = snap.data();
    if (saved.status === "paid") return res.status(200).json({ already: true });

    const check = await verifyWithFlutterwave(data.id);
    const v = check && check.data ? check.data : {};
    const ok =
      check.status === "success" &&
      v.status === "successful" &&
      v.tx_ref === data.tx_ref &&
      v.currency === saved.currency &&
      Number(v.amount) >= Number(saved.amount);
    if (!ok) {
      console.error("Flutterwave verify mismatch:", JSON.stringify({ saved, v }));
      return res.status(200).json({ ignored: "verify failed" });
    }

    const coins = Number(saved.coins);
    const walletRef = db.collection("wallets").doc(saved.uid);
    const txRef = db.collection("users").doc(saved.uid).collection("transactions").doc(String(data.tx_ref));

    await db.runTransaction(async (t) => {
      const fresh = await t.get(refDoc);
      if (fresh.data().status === "paid") return;
      const w = await t.get(walletRef);
      const bal = w.exists ? w.data().coinBalance || 0 : 0;
      t.set(walletRef, { coinBalance: Math.round((bal + coins) * 100) / 100 }, { merge: true });
      t.set(txRef, {
        type: "purchase",
        amount: coins,
        amountUsd: coins,
        provider: "flutterwave",
        flwRef: String(data.tx_ref),
        paidCurrency: saved.currency,
        paidAmount: Number(v.amount),
        createdAt: FieldValue.serverTimestamp(),
      });
      t.update(refDoc, { status: "paid", paidAt: FieldValue.serverTimestamp(), flwId: String(data.id) });
    });

    return res.status(200).json({ credited: true });
  } catch (err) {
    console.error(err);
    return res.status(500).send("Error");
  }
};
