const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();
const ORIGINS = ["https://stress-ochre.vercel.app", "http://localhost:5173"];

async function each(list, fn) {
  for (let i = 0; i < list.length; i += 20) {
    await Promise.all(list.slice(i, i + 20).map(fn));
  }
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;
    if (!decoded.auth_time || Date.now() / 1000 - decoded.auth_time > 600) {
      return res.status(401).json({ error: "Please enter your password again." });
    }
    if (uid === process.env.STRESS_FOUNDER_UID) {
      return res.status(400).json({ error: "This account cannot be deleted here." });
    }
    const pend = await db.collection("withdrawals").where("uid", "==", uid).where("status", "==", "pending").limit(1).get();
    if (!pend.empty) {
      return res.status(400).json({ error: "You have a pending withdrawal. Wait until it is paid, then try again." });
    }
    const user = await getAuth().getUser(uid);
    if (user.email && process.env.FLW_SECRET_KEY) {
      const hdr = { Authorization: "Bearer " + process.env.FLW_SECRET_KEY };
      const lr = await fetch("https://api.flutterwave.com/v3/subscriptions?email=" + encodeURIComponent(user.email), { headers: hdr });
      if (!lr.ok) return res.status(502).json({ error: "Could not check your subscription. Try again." });
      const lj = await lr.json();
      const active = ((lj && lj.data) || []).filter((s) => s.status === "active");
      for (const s of active) {
        const cr = await fetch("https://api.flutterwave.com/v3/subscriptions/" + s.id + "/cancel", { method: "PUT", headers: hdr });
        if (!cr.ok) return res.status(502).json({ error: "Could not stop your subscription. Try again." });
      }
    }

    const ref = db.collection("users").doc(uid);
    const following = await ref.collection("following").get();
    const followers = await ref.collection("followers").get();
    await each(following.docs, (d) => db.collection("users").doc(d.id).collection("followers").doc(uid).delete());
    await each(followers.docs, (d) => db.collection("users").doc(d.id).collection("following").doc(uid).delete());

    for (const c of await ref.listCollections()) {
      if (c.id === "transactions") continue;
      await db.recursiveDelete(c);
    }
    await ref.delete();
    await Promise.all(["wallets", "pins", "verificationSubscriptions", "verifiedUsers", "verificationCustomers", "emailCodes"].map((n) => db.collection(n).doc(uid).delete()));
    await getAuth().deleteUser(uid);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("delete-account:", err.message);
    return res.status(500).json({ error: "Could not delete account. Try again." });
  }
};
