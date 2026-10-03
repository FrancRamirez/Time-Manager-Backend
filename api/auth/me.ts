import { route, HttpError } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { query } from "../../lib/db";
import { toApiUser, type UserRow } from "../../lib/users";

/** Devuelve el usuario de la sesión (la app lo usa al arrancar para no pasar por el Login). */
export default route(["GET"], async (req, res) => {
  const userId = await requireUser(req);
  const rows = await query<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
  if (!rows[0]) {
    throw new HttpError(401, "La cuenta ya no existe", { code: "session_expired" });
  }
  res.status(200).json({ user: toApiUser(rows[0]) });
});
