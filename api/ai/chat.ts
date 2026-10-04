import { route, bodyOf, HttpError } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { sendMessageToGemini, type HistoryMessage } from "../../lib/gemini";
import { parseSettings } from "../../lib/schedule";
import { parseAlarms } from "../../lib/clock";
import { parseLocation } from "../../lib/weather";
import { messagesUsedToday, recordMessage, snapshot, type UsageSnapshot } from "../../lib/usage";

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY = 12;

function parseHistory(raw: unknown): HistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryMessage[] = [];
  for (const item of raw.slice(-MAX_HISTORY)) {
    if (typeof item !== "object" || item === null) continue;
    const { role, content } = item as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    if (!content.trim()) continue;
    out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  // Gemini exige que la conversación arranque con un turno del usuario.
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);

  const body = bodyOf(req);
  if (typeof body.message !== "string" || !body.message.trim()) {
    throw new HttpError(400, "Falta message");
  }
  if (body.message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, "El mensaje es demasiado largo");
  }

  // Cupo diario propio. Si la base de datos de uso falla, el chat sigue funcionando sin contador.
  let used: number | null = null;
  try {
    used = await messagesUsedToday(userId);
  } catch (err) {
    console.error("No se pudo leer ai_usage (¿falta ejecutar schema.sql?):", err);
  }
  if (used !== null) {
    const usage = snapshot(used);
    if (usage.limit > 0 && usage.used >= usage.limit) {
      throw new HttpError(429, "Llegaste al límite de mensajes de hoy.", {
        code: "user_limit",
        retryAfterSeconds: usage.resetsInSeconds,
        usage,
      });
    }
  }

  const result = await sendMessageToGemini({
    userId,
    message: body.message,
    history: parseHistory(body.history),
    timeZone: typeof body.timeZone === "string" ? body.timeZone : undefined,
    settings: parseSettings(body.settings),
    viaVoice: body.viaVoice === true,
    alarms: parseAlarms(body.alarms),
    location: parseLocation(body.location),
    locationUnavailable: body.locationUnavailable === true,
  });

  // Falta la ubicación para el pronóstico: no hubo respuesta para el usuario, así que no cuenta como
  // mensaje. La app obtiene la ubicación y reenvía el mismo mensaje.
  if (result.locationRequest) {
    res.status(200).json({ locationRequest: true, reply: result.reply });
    return;
  }

  // Solo se descuenta el mensaje si Gemini respondió (un error no le cuesta nada al usuario).
  let usage: UsageSnapshot | undefined;
  if (used !== null) {
    try {
      usage = snapshot(await recordMessage(userId));
    } catch (err) {
      console.error("No se pudo actualizar ai_usage:", err);
    }
  }
  res.status(200).json({ ...result, usage });
});
