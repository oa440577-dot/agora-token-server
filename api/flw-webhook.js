const crypto = require("crypto");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const got = Buffer.from(String(req.headers["verif-hash"] || ""));
    const want = Buffer.from(String(process.env.FLW_SECRET_HASH || ""));
    if (!want.length || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return res.status(401).send("Bad hash");
    }
    const event = req.body || {};
    const d = event.data || {};
    if (event.event !== "charge.completed" || !d.id || !d.tx_ref) return res.status(200).send("ignored");

    const refDoc = db.collection("flwRefs").doc(String(d.tx_ref));
    const snap = await refDoc.get();
    if (!snap.exists) return res.status(200).send("unknown reference");
    const rec = snap.data();
    if (rec.status === "done") return res.status(200).send("already done");

    const vr = await fetch("https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(d.id) + "/verify", {
      headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY },
    });
    const v = await vr.json().catch(() => ({}));
    const t = v && v.data;
    if (!vr.ok || !t || t.status !== "successful" || t.tx_ref !== d.tx_ref || t.currency !== (rec.currency || "NGN") || Number(t.amount) < Number(rec.amount != null ? rec.amount : rec.amountNgn)) {
      return res.status(200).send("not valid");
    }

    const walletRef = db.collection("wallets").doc(rec.uid);
    const txRef = db.collection("users").doc(rec.uid).collection("transactions").doc();
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(refDoc);
      if (cur.data().status === "done") return;
      const w = await tx.get(walletRef);
      const bal = w.exists ? Number(w.data().coinBalance) || 0 : 0;
      tx.set(walletRef, { coinBalance: Math.round((bal + rec.coins) * 100) / 100 }, { merge: true });
      tx.update(refDoc, { status: "done", flwId: String(d.id), paidAt: FieldValue.serverTimestamp() });
      tx.set(txRef, { type: "purchase", amount: rec.coins, amountUsd: rec.coins, ...(rec.currency && rec.currency !== "NGN" ? { currency: rec.currency, amountPaid: Number(rec.amount) } : { amountNgn: Number(rec.amount != null ? rec.amount : rec.amountNgn) }), provider: "flutterwave", reference: String(d.tx_ref), createdAt: FieldValue.serverTimestamp() });
    });
    return res.status(200).send("ok");
  } catch (err) {
    console.error("flw-webhook failed:", err.message);
    return res.status(500).send("error");
  }
};
