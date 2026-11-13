const crypto = require("crypto");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();
const hashOf = (uid, code) => crypto.createHash("sha256").update(uid + ":" + code).digest("hex");

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
    const code = String((req.body && req.body.code) || "").trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Enter the 6-digit code." });
    const ref = db.collection("emailCodes").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: "No code found. Tap Resend code." });
    const d = snap.data();
    if (Date.now() > d.expiresAt) return res.status(400).json({ error: "That code expired. Tap Resend code." });
    if ((d.attempts || 0) >= 5) return res.status(429).json({ error: "Too many wrong tries. Tap Resend code." });
    if (hashOf(uid, code) !== d.hash) {
      await ref.update({ attempts: (d.attempts || 0) + 1 });
      return res.status(400).json({ error: "Wrong code. Try again." });
    }
    await getAuth().updateUser(uid, { emailVerified: true });
    await ref.delete();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("verify-code failed:", err.message);
    return res.status(500).json({ error: "Could not check the code. Try again." });
  }
};
