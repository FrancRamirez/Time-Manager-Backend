import { route, bodyOf, HttpError } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { sendMessageToGemini, type HistoryMessage } from "../../lib/gemini";
import { parseSettings } from "../../lib/schedule";

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

  const result = await sendMessageToGemini({
    userId,
    message: body.message,
    history: parseHistory(body.history),
    timeZone: typeof body.timeZone === "string" ? body.timeZone : undefined,
    settings: parseSettings(body.settings),
    viaVoice: body.viaVoice === true,
  });
  res.status(200).json(result);
});
