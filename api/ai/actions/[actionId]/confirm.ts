import { route, bodyOf, HttpError } from "../../../../lib/http";
import { requireUser } from "../../../../lib/auth";
import { query, exec } from "../../../../lib/db";
import { getGoogleAccessTokenForUser } from "../../../../lib/tokens";
import {
  createCalendarEvent,
  patchCalendarEvent,
  deleteCalendarEvent,
} from "../../../../lib/google";

interface PendingActionRow {
  id: string;
  type: string;
  payload: unknown;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new HttpError(500, `Acción corrupta: falta ${field}`);
  return v;
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

    switch (action.type) {
      case "create":
        await createCalendarEvent(accessToken, {
          title: asString(payload.title, "title"),
          start: asString(payload.start, "start"),
          end: asString(payload.end, "end"),
          timeZone: asString(payload.timeZone, "timeZone"),
          location: typeof payload.location === "string" ? payload.location : undefined,
        });
        break;
      case "reschedule":
        await patchCalendarEvent(accessToken, asString(payload.eventId, "eventId"), {
          start: asString(payload.start, "start"),
          end: asString(payload.end, "end"),
          timeZone: asString(payload.timeZone, "timeZone"),
        });
        break;
      case "cancel":
        await deleteCalendarEvent(accessToken, asString(payload.eventId, "eventId"));
        break;
      default:
        throw new HttpError(500, `Tipo de acción desconocido: ${action.type}`);
    }
  } catch (err) {
    await exec("UPDATE pending_actions SET status = 'failed' WHERE id = ?", [action.id]);
    throw err;
  }

  res.status(200).json({ ok: true, executed: true });
});
