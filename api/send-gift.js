const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const MAX_GIFT = 10000;

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
    const decoded = await getAuth().verifyIdToken(token);
    const senderId = decoded.uid;

    const { chatId } = req.body || {};
    const amount = Number(req.body && req.body.amount);
    if (!chatId) return res.status(400).json({ error: "Bad request" });
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_GIFT) {
      return res.status(400).json({ error: "Enter a whole number from 1 to " + MAX_GIFT });
    }

    const chatRef = db.collection("chats").doc(chatId);
    const senderRef = db.collection("wallets").doc(senderId);

    await db.runTransaction(async (t) => {
      const chat = await t.get(chatRef);
      if (!chat.exists) throw new Error("Chat not found");
      const participants = chat.data().participants || [];
      if (!participants.includes(senderId)) throw new Error("Not in chat");
      const receiverId = participants.find((p) => p !== senderId);
      if (!receiverId) throw new Error("No recipient");
      const receiverRef = db.collection("wallets").doc(receiverId);

      const s = await t.get(senderRef);
      const r = await t.get(receiverRef);
      const bal = s.exists ? s.data().coinBalance || 0 : 0;
      const rbal = r.exists ? r.data().coinBalance || 0 : 0;
      if (bal < amount) throw new Error("NOT_ENOUGH_COINS");

      t.set(senderRef, { coinBalance: bal - amount }, { merge: true });
      t.set(receiverRef, { coinBalance: rbal + amount }, { merge: true });

      const label = "🎁 " + amount + " coins";
      t.set(chatRef.collection("messages").doc(), {
        type: "gift",
        amount,
        text: label,
        senderId,
        createdAt: FieldValue.serverTimestamp(),
      });
      t.set(
        chatRef,
        { lastMessage: label, lastMessageAt: FieldValue.serverTimestamp() },
        { merge: true }
      );

      t.set(db.collection("users").doc(senderId).collection("transactions").doc(), {
        type: "gift_sent",
        amount,
        toUid: receiverId,
        createdAt: FieldValue.serverTimestamp(),
      });
      t.set(db.collection("users").doc(receiverId).collection("transactions").doc(), {
        type: "gift_received",
        amount,
        fromUid: senderId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err.message === "NOT_ENOUGH_COINS") {
      return res.status(400).json({ error: "Not enough coins" });
    }
    console.error("send-gift failed:", err.message);
    return res.status(500).json({ error: "Gift failed" });
  }
};
