import { randomUUID } from "node:crypto";
import { route, bodyOf, HttpError } from "../../http";
import { requireUser } from "../../auth";
import { exec } from "../../db";

export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const body = bodyOf(req);

  if (typeof body.fcmToken !== "string") {
    throw new HttpError(400, "Falta fcmToken");
  }
  const platform = typeof body.platform === "string" ? body.platform : "android";

  // Un mismo fcmToken es único (ver schema): si ya existía (reinstalación,
  // otro usuario en el mismo dispositivo), lo reasigna al usuario actual.
  await exec(
    `INSERT INTO devices (id, user_id, fcm_token, platform)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform)`,
    [randomUUID(), userId, body.fcmToken, platform]
  );

  res.status(200).json({ ok: true });
});
