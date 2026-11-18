const crypto = require("crypto");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const supplied = Buffer.from(String(req.headers["verif-hash"] || ""));
    const secret = Buffer.from(String(
      process.env.FLW_WEBHOOK_SECRET_HASH || process.env.FLW_SECRET_HASH || ""
    ));
    if (!secret.length || supplied.length !== secret.length ||
        !crypto.timingSafeEqual(supplied, secret)) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.body || {};
    if (event.event !== "charge.completed" || !event.data?.id) {
      return res.status(200).json({ received: true });
    }

    const verifyResponse = await fetch(
      "https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(event.data.id) + "/verify",
      { headers: { Authorization: "Bearer " + process.env.FLW_SECRET_KEY } }
    );
    const verified = await verifyResponse.json();
    const tx = verified.data;

    const validNGN = tx && tx.currency === "NGN" && Number(tx.amount) >= 5000;
    const validUSD = tx && tx.currency === "USD" && Number(tx.amount) >= 5;

    if (!verifyResponse.ok || !tx || tx.status !== "successful" ||
        (!validNGN && !validUSD)) {
      return res.status(200).json({ received: true, verified: false });
    }

    const txRef = String(tx.tx_ref || "");
    let paymentRef = db.collection("verificationPayments").doc(txRef);
    let payment = await paymentRef.get();
    let uid = payment.exists ? payment.data().uid : null;

    if (!uid) {
      const email = String(tx.customer?.email || "").toLowerCase();
      if (email) {
        const match = await db.collection("verificationCustomers")
          .where("email", "==", email).limit(1).get();
        if (!match.empty) uid = match.docs[0].id;
      }
    }

    if (!uid || uid === process.env.STRESS_FOUNDER_UID) {
      return res.status(200).json({ received: true, matched: false });
    }

    const processedRef = db.collection("verificationTransactions").doc(String(tx.id));
    const subRef = db.collection("verificationSubscriptions").doc(uid);

    await db.runTransaction(async (t) => {
      const already = await t.get(processedRef);
      if (already.exists) return;

      t.set(processedRef, {
        uid, txRef, amount: Number(tx.amount), currency: tx.currency,
        createdAt: FieldValue.serverTimestamp()
      });

      t.set(subRef, {
        uid,
        email: String(tx.customer?.email || "").toLowerCase(),
        verified: true,
        status: "active",
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 32 * 24 * 60 * 60 * 1000)),
        lastPaymentAt: FieldValue.serverTimestamp(), cancelled: false,
        lastTransactionId: String(tx.id)
      }, { merge: true });

      t.set(db.collection("verifiedUsers").doc(uid), { expiresAt: Timestamp.fromDate(new Date(Date.now() + 32 * 24 * 60 * 60 * 1000)) });
    if (payment.exists) t.update(paymentRef, { status: "paid", transactionId: String(tx.id) });
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("verification webhook:", err.message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};
