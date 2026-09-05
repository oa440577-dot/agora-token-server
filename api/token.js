const { RtcTokenBuilder, RtcRole } = require("agora-token");

module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  const channelName = req.query.channelName;
  const uid = req.query.uid || 0;
  const role = req.query.role === "audience" ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;

  if (!channelName) {
    return res.status(400).json({ error: "channelName is required" });
  }

  if (!appId || !appCertificate) {
    return res.status(500).json({ error: "Server not configured" });
  }

  const expireSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpireTs = currentTimestamp + expireSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    Number(uid),
    role,
    privilegeExpireTs,
    privilegeExpireTs
  );

  res.status(200).json({ token, appId });
};
