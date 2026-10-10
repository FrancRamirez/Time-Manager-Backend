import { route, bodyOf, HttpError } from "../../http";
import { requireAccess } from "../../billing";
import { query, exec } from "../../db";
import { getGoogleAccessTokenForUser } from "../../tokens";
import { executeAction } from "../../actions";
import { actionApp, appAllows, restrictionText } from "../../access";
import { parseSettings } from "../../schedule";
import { tr } from "../../lang";

interface PendingActionRow {
  id: string;
  type: string;
  payload: unknown;
}

/** Por qué no se encontró una acción vigente: se distingue para dar un mensaje claro y para el log. */
async function whyNotFound(actionId: string, userId: string): Promise<HttpError> {
  let row: { status: string; mine: number | string; expired: number | string } | undefined;
  try {
    [row] = await query<{ status: string; mine: number | string; expired: number | string }>(
      `SELECT status,
              (user_id = ?) AS mine,
              (created_at <= NOW() - INTERVAL 1 HOUR) AS expired
       FROM pending_actions WHERE id = ?`,
      [userId, actionId]
    );
  } catch (err) {
    console.error("confirm: no se pudo averiguar el motivo del 404:", err);
  }

  if (!row || Number(row.mine) !== 1) {
    console.error("confirm 404: la acción no existe para este usuario", { actionId });
    return new HttpError(404, tr("No encontré esa acción. Pídesela de nuevo a Frami.", "I couldn't find that action. Ask Frami again."), {
      code: "action_not_found",
    });
  }
  if (row.status === "pending" && Number(row.expired) === 1) {
    console.error("confirm 404: la acción venció", { actionId });
    return new HttpError(404, tr("Esta acción venció (duran una hora). Pídesela de nuevo a Frami.", "This action expired (they last one hour). Ask Frami again."), {
      code: "action_expired",
    });
  }
  console.error("confirm 404: la acción ya estaba resuelta", { actionId, status: row.status });
  return new HttpError(
    409,
    row.status === "failed"
      ? tr("Esta acción falló antes y ya no se puede reintentar. Pídesela de nuevo a Frami.", "This action failed before and can't be retried. Ask Frami again.")
      : tr("Esta acción ya se había resuelto. Revisa tu agenda: puede que ya esté lista.", "This action was already resolved. Check your schedule: it may already be done."),
    { code: "action_resolved", status: row.status }
  );
}

export default route(["POST"], async (req, res) => {
  const userId = await requireAccess(req);

  const body = bodyOf(req);
  // El id viaja en el cuerpo (/api/ai/confirm) o en la ruta (/api/ai/actions/:actionId/confirm).
  const rawId = typeof req.query.actionId === "string" ? req.query.actionId : body.actionId;
  if (typeof rawId !== "string" || !rawId || rawId.length > 64) {
    throw new HttpError(400, "Falta actionId", { code: "action_bad_request" });
  }
  const actionId = rawId;

  if (typeof body.approve !== "boolean") {
    throw new HttpError(400, "Falta approve (boolean)", { code: "action_bad_request" });
  }
  console.info("confirm: pedido recibido", { actionId, approve: body.approve });

  // Las acciones propuestas vencen a la hora: evita confirmar algo viejo.
  const rows = await query<PendingActionRow>(
    `SELECT id, type, payload FROM pending_actions
     WHERE id = ? AND user_id = ? AND status = 'pending'
       AND created_at > NOW() - INTERVAL 1 HOUR`,
    [actionId, userId]
  );
  const action = rows[0];
  if (!action) {
    throw await whyNotFound(actionId, userId);
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
    throw new HttpError(409, tr("Esta acción ya se había resuelto. Revisa tu agenda: puede que ya esté lista.", "This action was already resolved. Check your schedule: it may already be done."), {
      code: "action_resolved",
    });
  }

  // mysql2 devuelve las columnas JSON ya parseadas; por si llegara como texto:
  const payload = (
    typeof action.payload === "string" ? JSON.parse(action.payload) : action.payload
  ) as Record<string, unknown>;

  try {
    const accessToken = await getGoogleAccessTokenForUser(userId);
    await executeAction(accessToken, action.type, payload);
  } catch (err) {
    // Fallo pasajero (Google caído, límite por minuto, red): la acción NO se pierde. Vuelve a
    // "pendiente" para que el usuario pueda reintentar con un toque, sin pedirle nada de nuevo a la
    // IA (que justo puede estar saturada). Vence a la hora, así que no queda abierta para siempre.
    // Fallo definitivo (permiso, datos inválidos): se marca fallida y no se reintenta.
    const transient =
      err instanceof HttpError ? err.extra?.retryable === true || err.status === 429 : true;
    try {
      await exec("UPDATE pending_actions SET status = ? WHERE id = ?", [
        transient ? "pending" : "failed",
        action.id,
      ]);
    } catch (dbErr) {
      console.error("No se pudo actualizar el estado de la acción:", dbErr);
    }
    if (err instanceof HttpError) {
      throw new HttpError(err.status, err.message, {
        ...err.extra,
        retryable: transient,
      });
    }
    console.error("Confirmar acción falló:", err);
    throw new HttpError(503, tr("No pude completar la acción en este momento. Prueba de nuevo.", "I couldn't complete the action right now. Please try again."), {
      code: "action_failed",
      retryable: true,
    });
  }

  res.status(200).json({ ok: true, executed: true });
});
