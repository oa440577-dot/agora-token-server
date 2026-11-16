const { FieldValue } = require("firebase-admin/firestore");

async function creditPayment(db, txRef, transactionId) {
  const refDoc = db.collection("flwRefs").doc(String(txRef));
  const snap = await refDoc.get();
  if (!snap.exists) return { ok: false, reason: "unknown reference" };
  const rec = snap.data();
  if (rec.status === "done") return { ok: true, uid: rec.uid, coins: rec.coins };
  const vr = await fetch("https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(transactionId) + "/verify", {
    headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY },
  });
  const v = await vr.json().catch(() => ({}));
  const t = v && v.data;
  const need = Number(rec.amount != null ? rec.amount : rec.amountNgn);
  const cur = rec.currency || "NGN";
  if (!vr.ok || !t || t.status !== "successful" || t.tx_ref !== String(txRef) || t.currency !== cur || Number(t.amount) < need) {
    console.error("flw verify rejected", JSON.stringify({ http: vr.status, status: t && t.status, cur: t && t.currency, amt: t && t.amount, need }));
    return { ok: false, reason: "not valid" };
  }
  const walletRef = db.collection("wallets").doc(rec.uid);
  const txDoc = db.collection("users").doc(rec.uid).collection("transactions").doc();
  await db.runTransaction(async (tx) => {
    const again = await tx.get(refDoc);
    if (again.data().status === "done") return;
    const w = await tx.get(walletRef);
    const bal = w.exists ? Number(w.data().coinBalance) || 0 : 0;
    tx.set(walletRef, { coinBalance: Math.round((bal + rec.coins) * 100) / 100 }, { merge: true });
    tx.update(refDoc, { status: "done", flwId: String(transactionId), paidAt: FieldValue.serverTimestamp() });
    tx.set(txDoc, { type: "purchase", amount: rec.coins, amountUsd: rec.coins, provider: "flutterwave", reference: String(txRef), ...(cur !== "NGN" ? { currency: cur, amountPaid: need } : { amountNgn: need }), createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true, uid: rec.uid, coins: rec.coins };
}

module.exports = { creditPayment };
