const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { setPin, checkPin } = require("./_pin");

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not signed in" });
    const uid = (await getAuth().verifyIdToken(token)).uid;

    const { pin, currentPin } = req.body || {};
    if (!/^\d{5}$/.test(String(pin || ""))) {
      return res.status(400).json({ error: "PIN must be exactly 5 digits" });
    }

    const existing = await db.collection("pins").doc(uid).get();
    if (existing.exists) {
      const r = await checkPin(db, uid, String(currentPin || ""));
      if (!r.ok) {
        const msg = r.code === "LOCKED"
          ? "Too many tries. Try again in 30 minutes."
          : "Current PIN is wrong";
        return res.status(400).json({ error: msg });
      }
    }

    await setPin(db, uid, String(pin));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("set-pin failed:", err.message);
    return res.status(500).json({ error: "Could not save PIN" });
  }
};
