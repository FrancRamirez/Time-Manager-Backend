import { route, bodyOf, HttpError } from "../../../lib/http";
import { requireUser } from "../../../lib/auth";
import { query, exec } from "../../../lib/db";
import { getGoogleAccessTokenForUser } from "../../../lib/tokens";
import { getCalendarEvent, patchCalendarEvent } from "../../../lib/google";
import {
  checkSlot,
  parseSettings,
  safeTimeZone,
  utcMsToLocal,
  type SlotCheck,
} from "../../../lib/schedule";

interface SuggestionRow {
  id: string;
  proposed_starts_at: string;
  proposed_ends_at: string;
}

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Los horarios guardados pueden venir con offset ("...-03:00" / "...Z") o sin él.
 * Se normalizan a hora local del usuario ("YYYY-MM-DDTHH:mm:ss") para validarlos
 * y para mandarlos a Calendar junto con su zona horaria.
 */
function toLocalNaive(value: string, tz: string): string {
  const v = value.trim();
  if (HAS_OFFSET.test(v)) {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new HttpError(500, "Sugerencia con horario inválido");
    return utcMsToLocal(ms, tz);
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(v);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T${m[2]}:${m[3] ?? "00"}Z`))) {
    throw new HttpError(500, "Sugerencia con horario inválido");
  }
  return `${m[1]}T${m[2]}:${m[3] ?? "00"}`;
}

function conflictMessage(check: SlotCheck, bufferMinutes: number): string | null {
  if (check.blocked.length) {
    return `El nuevo horario cae en una franja intocable (${check.blocked[0]}).`;
  }
  const c = check.conflicts[0];
  if (c) {
    return c.kind === "overlap"
      ? `El nuevo horario ya no está libre: se superpone con "${c.title}".`
      : `El nuevo horario queda a menos de ${bufferMinutes} min de "${c.title}".`;
  }
  return null;
}

export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const eventId = req.query.eventId;
  if (typeof eventId !== "string") {
    throw new HttpError(400, "Falta eventId");
  }

  const body = bodyOf(req);
  if (typeof body.accepted !== "boolean") {
    throw new HttpError(400, "Falta accepted (boolean)");
  }

  const rows = await query<SuggestionRow>(
    `SELECT id, proposed_starts_at, proposed_ends_at FROM suggestions
     WHERE user_id = ? AND event_id = ? AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [userId, eventId]
  );
  const suggestion = rows[0];
  if (!suggestion) {
    throw new HttpError(404, "Sugerencia no encontrada o ya resuelta");
  }

  if (!body.accepted) {
    await exec("UPDATE suggestions SET status = 'rejected' WHERE id = ?", [suggestion.id]);
    res.status(200).json({ ok: true });
    return;
  }

  const tz = safeTimeZone(typeof body.timeZone === "string" ? body.timeZone : undefined);
  const settings = parseSettings(body.settings);
  if (settings.appAccess.calendar !== "allowed") {
    throw new HttpError(
      403,
      "Google Calendar está restringido para el asistente. Cámbialo en Ajustes > Restringir aplicaciones.",
      { code: "app_restricted" }
    );
  }
  const accessToken = await getGoogleAccessTokenForUser(userId);

  // El evento pudo borrarse o cancelarse desde Calendar después de la sugerencia.
  const event = await getCalendarEvent(accessToken, eventId);
  if (!event) {
    await exec("UPDATE suggestions SET status = 'stale' WHERE id = ?", [suggestion.id]);
    throw new HttpError(404, "El evento ya no existe en tu calendario.");
  }

  const start = toLocalNaive(suggestion.proposed_starts_at, tz);
  const end = toLocalNaive(suggestion.proposed_ends_at, tz);

  // El horario propuesto pudo ocuparse desde que se generó la sugerencia.
  // Se respetan también el buffer y las franjas intocables del usuario.
  const check = await checkSlot({
    accessToken,
    start,
    end,
    tz,
    settings,
    ignoreEventId: eventId,
  });
  const problem = conflictMessage(check, settings.bufferMinutes);
  if (problem) {
    // La sugerencia sigue pendiente: el usuario puede ignorarla o resolverlo a mano.
    throw new HttpError(409, problem);
  }

  // Se reclama de forma atómica antes de tocar Calendar (evita doble aplicación).
  const claim = await exec(
    "UPDATE suggestions SET status = 'accepted' WHERE id = ? AND status = 'pending'",
    [suggestion.id]
  );
  if (claim.affectedRows !== 1) {
    throw new HttpError(409, "La sugerencia ya fue resuelta.");
  }

  try {
    await patchCalendarEvent(accessToken, eventId, { start, end, timeZone: tz });
  } catch (err) {
    // Si Calendar falla, la sugerencia vuelve a quedar pendiente para reintentar.
    await exec("UPDATE suggestions SET status = 'pending' WHERE id = ?", [suggestion.id]);
    throw err;
  }

  res.status(200).json({ ok: true });
});
