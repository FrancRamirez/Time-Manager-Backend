import { route, HttpError } from "../../http";
import { requireUser } from "../../auth";
import { query } from "../../db";
import { toApiUser, type UserRow } from "../../users";

/** Devuelve el usuario de la sesión (la app lo usa al arrancar para no pasar por el Login). */
export default route(["GET"], async (req, res) => {
  const userId = await requireUser(req);
  const rows = await query<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
  if (!rows[0]) {
    throw new HttpError(401, "La cuenta ya no existe", { code: "session_expired" });
  }
  res.status(200).json({ user: toApiUser(rows[0]) });
});
