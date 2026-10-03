import { HttpError } from "./http";
import { createCalendarEvent, patchCalendarEvent, deleteCalendarEvent } from "./google";
import {
  createDraft,
  isMessageId,
  modifyLabels,
  parseRecipients,
  sendEmail,
  trashEmail,
  type OutgoingEmail,
} from "./gmail";

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new HttpError(500, `Acción corrupta: falta ${field}`);
  return v;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function messageId(v: unknown): string {
  if (!isMessageId(v)) throw new HttpError(500, "Acción corrupta: falta messageId");
  return v;
}

/** Reconstruye el correo desde el payload guardado, revalidando las direcciones. */
function outgoing(payload: Record<string, unknown>): OutgoingEmail {
  const to = parseRecipients(asStrings(payload.to));
  const cc = parseRecipients(asStrings(payload.cc));
  if (to.invalid.length || cc.invalid.length || to.emails.length === 0) {
    throw new HttpError(500, "Acción corrupta: destinatarios inválidos");
  }
  return {
    to: to.emails,
    cc: cc.emails,
    subject: asString(payload.subject, "subject"),
    body: asString(payload.body, "body"),
    threadId: isMessageId(payload.threadId) ? payload.threadId : undefined,
    inReplyTo: typeof payload.inReplyTo === "string" ? payload.inReplyTo : undefined,
    references: typeof payload.references === "string" ? payload.references : undefined,
  };
}

/**
 * Ejecuta una acción ya validada contra Google Calendar o Gmail. Lo usan tanto la
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
    case "email_draft":
      await createDraft(accessToken, outgoing(payload));
      return;
    case "email_send":
      await sendEmail(accessToken, outgoing(payload));
      return;
    case "email_modify":
      await modifyLabels(
        accessToken,
        messageId(payload.messageId),
        asStrings(payload.add),
        asStrings(payload.remove)
      );
      return;
    case "email_trash":
      await trashEmail(accessToken, messageId(payload.messageId));
      return;
    default:
      throw new HttpError(500, `Tipo de acción desconocido: ${type}`);
  }
}
