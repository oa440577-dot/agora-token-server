const crypto = require("crypto");

const MAX_TRIES = 5;
const LOCK_MS = 30 * 60 * 1000;

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString("hex");
}

async function setPin(db, uid, pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  await db.collection("pins").doc(uid).set({
    salt,
    hash: hashPin(pin, salt),
    fails: 0,
    lockedUntil: 0,
    updatedAt: Date.now(),
  });
}

async function checkPin(db, uid, pin) {
  const ref = db.collection("pins").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: "NO_PIN" };
  const d = snap.data();
  if (d.lockedUntil > Date.now()) return { ok: false, code: "LOCKED" };
  const given = Buffer.from(hashPin(String(pin), d.salt), "hex");
  const saved = Buffer.from(d.hash, "hex");
  if (crypto.timingSafeEqual(given, saved)) {
    if (d.fails) await ref.update({ fails: 0, lockedUntil: 0 });
    return { ok: true };
  }
  const fails = (d.fails || 0) + 1;
  if (fails >= MAX_TRIES) {
    await ref.update({ fails: 0, lockedUntil: Date.now() + LOCK_MS });
    return { ok: false, code: "LOCKED" };
  }
  await ref.update({ fails });
  return { ok: false, code: "WRONG_PIN", left: MAX_TRIES - fails };
}

module.exports = { setPin, checkPin };
