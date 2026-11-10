const Stripe = require("stripe");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const COIN_USD = 100;

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];
  const rawBody = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const uid = session.metadata.uid;
    const amountUsd = Number(session.metadata.amountUsd);
    const coins = Math.round((amountUsd / COIN_USD) * 100) / 100;

    if (uid && amountUsd) {
      const userRef = db.collection("users").doc(uid);
      const walletRef = db.collection("wallets").doc(uid);

      await db.runTransaction(async (t) => {
        const doc = await t.get(walletRef);
        const currentBalance = doc.exists ? (doc.data().coinBalance || 0) : 0;
        t.set(
          walletRef,
          { coinBalance: Math.round((currentBalance + coins) * 100) / 100 },
          { merge: true }
        );
      });

      await userRef.collection("transactions").add({
        type: "purchase",
        amount: coins,
        amountUsd,
        stripeSessionId: session.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
