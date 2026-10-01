import { HttpError } from "./http";
import { createCalendarEvent, patchCalendarEvent, deleteCalendarEvent } from "./google";

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new HttpError(500, `Acción corrupta: falta ${field}`);
  return v;
}

/**
 * Ejecuta una acción ya validada contra Google Calendar. Lo usan tanto la
 * confirmación manual (ai/actions/:id/confirm) como el modo Piloto Automático.
 */
export async function executeAction(
  accessToken: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  switch (type) {
    case "create":
      await createCalendarEvent(accessToken, {
        title: asString(payload.title, "title"),
        start: asString(payload.start, "start"),
        end: asString(payload.end, "end"),
        timeZone: asString(payload.timeZone, "timeZone"),
        location: typeof payload.location === "string" ? payload.location : undefined,
      });
      return;
    case "reschedule":
      await patchCalendarEvent(accessToken, asString(payload.eventId, "eventId"), {
        start: asString(payload.start, "start"),
        end: asString(payload.end, "end"),
        timeZone: asString(payload.timeZone, "timeZone"),
      });
      return;
    case "cancel":
      await deleteCalendarEvent(accessToken, asString(payload.eventId, "eventId"));
      return;
    default:
      throw new HttpError(500, `Tipo de acción desconocido: ${type}`);
  }
}
