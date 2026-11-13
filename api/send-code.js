const crypto = require("crypto");
const nodemailer = require("nodemailer");
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
    const user = await getAuth().getUser(uid);
    if (user.emailVerified) return res.status(200).json({ ok: true, verified: true });
    const ref = db.collection("emailCodes").doc(uid);
    const snap = await ref.get();
    const now = Date.now();
    if (snap.exists && now - (snap.data().sentAt || 0) < 60000) {
      return res.status(429).json({ error: "Please wait a minute before asking for another code." });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    await ref.set({ hash: hashOf(uid, code), expiresAt: now + 10 * 60 * 1000, attempts: 0, sentAt: now });
    const mail = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    await mail.sendMail({
      from: '"STRESS" <' + process.env.GMAIL_USER + ">",
      to: user.email,
      subject: "Your STRESS verification code",
      text: "Your STRESS verification code is " + code + ". It expires in 10 minutes. If you did not sign up, you can ignore this email.",
      html: '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="letter-spacing:3px">STRESS</h2><p>Your verification code is</p><p style="font-size:34px;font-weight:800;letter-spacing:8px">' + code + '</p><p style="color:#777">It expires in 10 minutes. If you did not sign up, ignore this email.</p></div>',
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-code failed:", err.message);
    return res.status(500).json({ error: "Could not send the code. Try again." });
  }
};
