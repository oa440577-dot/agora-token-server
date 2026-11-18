const { FieldValue, Timestamp } = require("firebase-admin/firestore");
module.exports = async function verifyBadge(db, uid, txRef, txId) {
  const payRef = db.collection("verificationPayments").doc(txRef);
  const pay = await payRef.get();
  if (!pay.exists || pay.data().uid !== uid) return { ok: false };
  const r = await fetch("https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(txId) + "/verify", {
    headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY }
  });
  const j = await r.json();
  const tx = j.data;
  const good = tx && tx.status === "successful" && tx.tx_ref === txRef &&
    ((tx.currency === "NGN" && Number(tx.amount) >= 5000) || (tx.currency === "USD" && Number(tx.amount) >= 5));
  if (!r.ok || !good) return { ok: false };
  const done = db.collection("verificationTransactions").doc(String(tx.id));
  await db.runTransaction(async (t) => {
    if ((await t.get(done)).exists) return;
    t.set(done, { uid, txRef, amount: Number(tx.amount), currency: tx.currency, createdAt: FieldValue.serverTimestamp() });
    t.set(db.collection("verificationSubscriptions").doc(uid), {
      uid, verified: true, status: "active",
      email: String(tx.customer && tx.customer.email || "").toLowerCase(),
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 32 * 24 * 60 * 60 * 1000)),
      lastPaymentAt: FieldValue.serverTimestamp(), cancelled: false, lastTransactionId: String(tx.id)
    }, { merge: true });
    t.set(db.collection("verifiedUsers").doc(uid), { expiresAt: Timestamp.fromDate(new Date(Date.now() + 32 * 24 * 60 * 60 * 1000)) });
    t.update(payRef, { status: "paid", transactionId: String(tx.id) });
  });
  return { ok: true };
};
