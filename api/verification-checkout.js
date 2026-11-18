const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Sign in first" });

    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;
    if (req.body && req.body.action === "cancel") {
      const u = await getAuth().getUser(uid);
      if (!u.email) return res.status(400).json({ error: "No email on account" });
      const auth = { Authorization: "Bearer " + process.env.FLW_SECRET_KEY };
      const lr = await fetch("https://api.flutterwave.com/v3/subscriptions?email=" + encodeURIComponent(u.email), { headers: auth });
      const lj = await lr.json();
      const active = ((lj && lj.data) || []).filter((s) => s.status === "active");
      let n = 0;
      for (const s of active) {
        const cr = await fetch("https://api.flutterwave.com/v3/subscriptions/" + s.id + "/cancel", { method: "PUT", headers: auth });
        if (cr.ok) n++;
      }
      if (active.length && !n) return res.status(502).json({ error: "Could not cancel. Try again." });
      if (n) await db.collection("verificationSubscriptions").doc(uid).set({ cancelled: true, cancelledAt: FieldValue.serverTimestamp() }, { merge: true });
      return res.status(200).json({ ok: true, cancelled: n });
    }

    if (uid === process.env.STRESS_FOUNDER_UID) {
      return res.status(400).json({ error: "Founder verification is free" });
    }

    if (!process.env.FLW_SECRET_KEY) {
      return res.status(503).json({ error: "Payment service is not configured yet" });
    }

    const user = await getAuth().getUser(uid);
    if (!user.email) return res.status(400).json({ error: "Add an email to your account first" });
    const country = String(req.headers["x-vercel-ip-country"] || "").toUpperCase();
    const isNigeria = country === "NG";
    const currency = isNigeria ? "NGN" : "USD";
    const amount = isNigeria ? 5000 : 5;
    const planId = isNigeria
      ? process.env.FLW_VERIFICATION_NGN_PLAN_ID
      : process.env.FLW_VERIFICATION_PLAN_ID;

    if (!planId || !Number.isFinite(Number(planId))) {
      return res.status(503).json({ error: "Subscription plan is not configured" });
    }

    const txRef = "stress_verified_" + uid + "_" + Date.now();
    const pending = db.collection("verificationPayments").doc(txRef);

    await pending.set({
      uid,
      email: user.email.toLowerCase(),
      amount,
      currency,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });

    await db.collection("verificationCustomers").doc(uid).set({
      email: user.email.toLowerCase(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.FLW_SECRET_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency,
        payment_plan: Number(planId),
        redirect_url: "https://stress-ochre.vercel.app/",
        customer: { email: user.email, name: user.displayName || "STRESS User" },
        meta: { uid, purpose: "STRESS_VERIFIED" },
        customizations: {
          title: "STRESS Verified",
          description: "Monthly verified badge subscription"
        }
      })
    });

    const result = await response.json();
    if (!response.ok || !result.data?.link) {
      await pending.update({ status: "checkout_failed" });
      console.error("Flutterwave checkout error:", result);
      return res.status(502).json({ error: "Could not start payment" });
    }

    return res.status(200).json({ ok: true, link: result.data.link });
  } catch (err) {
    console.error("verification checkout:", err.message);
    return res.status(500).json({ error: "Could not start verification" });
  }
};
