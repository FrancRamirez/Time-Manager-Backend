import { route, bodyOf, HttpError } from "../../../../lib/http";
import { requireUser } from "../../../../lib/auth";
import { query, exec } from "../../../../lib/db";
import { getGoogleAccessTokenForUser } from "../../../../lib/tokens";
import { executeAction } from "../../../../lib/actions";
import { actionApp, appAllows, restrictionText } from "../../../../lib/access";
import { parseSettings } from "../../../../lib/schedule";

interface PendingActionRow {
  id: string;
  type: string;
  payload: unknown;
}

export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const actionId = req.query.actionId;
  if (typeof actionId !== "string") {
    throw new HttpError(400, "Falta actionId");
  }

  const body = bodyOf(req);
  if (typeof body.approve !== "boolean") {
    throw new HttpError(400, "Falta approve (boolean)");
  }

  // Las acciones propuestas vencen a la hora: evita confirmar algo viejo.
  const rows = await query<PendingActionRow>(
    `SELECT id, type, payload FROM pending_actions
     WHERE id = ? AND user_id = ? AND status = 'pending'
       AND created_at > NOW() - INTERVAL 1 HOUR`,
    [actionId, userId]
  );
  const action = rows[0];
  if (!action) {
    throw new HttpError(404, "Acción no encontrada, vencida o ya resuelta");
  }

  if (!body.approve) {
    await exec("UPDATE pending_actions SET status = 'rejected' WHERE id = ?", [action.id]);
    res.status(200).json({ ok: true, executed: false });
    return;
  }

  // El usuario pudo restringir la app después de que se propuso la acción. La app manda sus
  // ajustes al confirmar; la acción queda pendiente (vence a la hora) por si los vuelve a cambiar.
  const access = parseSettings(body.settings).appAccess;
  const app = actionApp(action.type);
  if (app && !appAllows(access, app, true)) {
    throw new HttpError(403, restrictionText(app, access[app]), { code: "app_restricted" });
  }

  // Se "reclama" la acción de forma atómica antes de ejecutarla, para que un
  // doble toque en Confirmar no cree/mueva el evento dos veces.
  const claim = await exec(
    "UPDATE pending_actions SET status = 'executed' WHERE id = ? AND status = 'pending'",
    [action.id]
  );
  if (claim.affectedRows !== 1) {
    throw new HttpError(409, "La acción ya fue resuelta");
  }

  // mysql2 devuelve las columnas JSON ya parseadas; por si llegara como texto:
  const payload = (
    typeof action.payload === "string" ? JSON.parse(action.payload) : action.payload
  ) as Record<string, unknown>;

  try {
    const accessToken = await getGoogleAccessTokenForUser(userId);
    await executeAction(accessToken, action.type, payload);
  } catch (err) {
    await exec("UPDATE pending_actions SET status = 'failed' WHERE id = ?", [action.id]);
    throw err;
  }

  res.status(200).json({ ok: true, executed: true });
});
