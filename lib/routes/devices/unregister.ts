import { route, bodyOf, HttpError } from "../../http";
import { requireUser } from "../../auth";
import { exec } from "../../db";

/**
 * Da de baja un dispositivo (al cerrar sesión), para que el servidor deje de mandarle avisos de la
 * cuenta. Solo borra el token si pertenece al usuario de la sesión.
 */
export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const { fcmToken } = bodyOf(req);
  if (typeof fcmToken !== "string" || !fcmToken) throw new HttpError(400, "Falta fcmToken");

  await exec("DELETE FROM devices WHERE fcm_token = ? AND user_id = ?", [fcmToken, userId]);
  res.status(200).json({ ok: true });
});
