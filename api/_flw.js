const { FieldValue } = require("firebase-admin/firestore");

async function creditPayment(db, txRef, transactionId) {
  txRef = String(txRef || "");
  transactionId = String(transactionId || "");

  if (!txRef || !/^\d+$/.test(transactionId)) {
    return { ok: false, reason: "invalid details" };
  }

  const refDoc = db.collection("flwRefs").doc(txRef);
  const snap = await refDoc.get();

  if (!snap.exists) {
    return { ok: false, reason: "unknown reference" };
  }

  const rec = snap.data();
  const coins = Number(rec.coins);
  const need = Number(rec.amount != null ? rec.amount : rec.amountNgn);
  const cur = rec.currency || "NGN";

  if (!rec.uid || !Number.isFinite(coins) || coins <= 0 ||
      !Number.isFinite(need) || need <= 0) {
    return { ok: false, reason: "invalid payment record" };
  }

  const alreadyPaid = ["done", "paid"].includes(rec.status);

  if (alreadyPaid && rec.flwId) {
    if (String(rec.flwId) !== transactionId) {
      return { ok: false, reason: "transaction mismatch" };
    }
    return { ok: true, uid: rec.uid, coins };
  }

  const vr = await fetch(
    "https://api.flutterwave.com/v3/transactions/" +
      encodeURIComponent(transactionId) + "/verify",
    {
      headers: {
        Authorization: "Bearer " + process.env.FLW_SECRET_KEY
      }
    }
  );

  const v = await vr.json().catch(() => ({}));
  const t = v && v.data;

  if (!vr.ok || !v || v.status !== "success" || !t ||
      t.status !== "successful" ||
      t.tx_ref !== txRef ||
      t.currency !== cur ||
      !Number.isFinite(Number(t.amount)) ||
      Number(t.amount) < need) {
    console.error("flw verify rejected", JSON.stringify({
      http: vr.status,
      status: t && t.status,
      cur: t && t.currency,
      amt: t && t.amount,
      need
    }));
    return { ok: false, reason: "not valid" };
  }

  const walletRef = db.collection("wallets").doc(rec.uid);
  const txDoc = db.collection("users").doc(rec.uid)
    .collection("transactions").doc(txRef);

  const result = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(refDoc);

    if (!fresh.exists) {
      return { ok: false, reason: "unknown reference" };
    }

    const current = fresh.data();

    if (["done", "paid"].includes(current.status)) {
      if (current.flwId &&
          String(current.flwId) !== transactionId) {
        return { ok: false, reason: "transaction mismatch" };
      }

      if (!current.flwId) {
        tx.update(refDoc, { flwId: transactionId });
      }

      return { ok: true, uid: rec.uid, coins };
    }

    const w = await tx.get(walletRef);
    const bal = w.exists ? Number(w.data().coinBalance) || 0 : 0;

    tx.set(walletRef, {
      coinBalance: Math.round((bal + coins) * 100) / 100
    }, { merge: true });

    tx.update(refDoc, {
      status: "paid",
      flwId: transactionId,
      paidAt: FieldValue.serverTimestamp()
    });

    tx.set(txDoc, {
      type: "purchase",
      amount: coins,
      amountUsd: coins,
      provider: "flutterwave",
      reference: txRef,
      ...(cur !== "NGN"
        ? { currency: cur, amountPaid: need }
        : { amountNgn: need }),
      createdAt: FieldValue.serverTimestamp()
    });

    return { ok: true, uid: rec.uid, coins };
  });

  return result;
}

module.exports = { creditPayment };
