const crypto = require("crypto");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { creditPayment } = require("./_flw");

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const handleVerify = require("./_flwverify");

module.exports = async (req, res) => {
  if (req.query && req.query.mode === "verify") return handleVerify(req, res);
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const got = Buffer.from(String(req.headers["verif-hash"] || ""));
    const want = Buffer.from(String(process.env.FLW_WEBHOOK_SECRET_HASH || process.env.FLW_SECRET_HASH || ""));
    if (!want.length || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      console.error("flw-webhook: hash mismatch or FLW_SECRET_HASH missing");
      return res.status(401).send("Bad hash");
    }
    const event = req.body || {};
    const d = event.data || {};
    if (event.event !== "charge.completed" || !d.id || !d.tx_ref) return res.status(200).send("ignored");
    const out = await creditPayment(db, d.tx_ref, d.id);
    return res.status(200).send(out.ok ? "ok" : out.reason);
  } catch (err) {
    console.error("flw-webhook failed:", err.message);
    return res.status(500).send("error");
  }
};
