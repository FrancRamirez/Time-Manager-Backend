import { route, bodyOf, HttpError } from "../../lib/http";
import { query } from "../../lib/db";
import { signAccessToken, verifyTokenFull } from "../../lib/auth";
import { toApiUser, type UserRow } from "../../lib/users";

/**
 * Renueva el accessToken con el refreshToken propio. No emite un refresh nuevo y el access nuevo
 * nunca vence después del refresh: la sesión dura lo que dura el refreshToken (7 días por defecto).
 */
export default route(["POST"], async (req, res) => {
  const { refreshToken } = bodyOf(req);
  if (typeof refreshToken !== "string") throw new HttpError(400, "Falta refreshToken");

  const { sub, exp } = await verifyTokenFull(refreshToken, "refresh");
  const rows = await query<UserRow>("SELECT * FROM users WHERE id = ?", [sub]);
  if (!rows[0]) {
    throw new HttpError(401, "La cuenta ya no existe", { code: "session_expired" });
  }

  const accessToken = await signAccessToken(sub, exp);
  res.status(200).json({ accessToken, user: toApiUser(rows[0]) });
});
