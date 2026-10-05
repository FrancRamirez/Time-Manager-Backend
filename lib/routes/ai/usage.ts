import { route } from "../../http";
import { requireUser } from "../../auth";
import { aiQuotaWaitSeconds } from "../../gemini";
import { messagesUsedToday, snapshot } from "../../usage";

/** GET /api/ai/usage: mensajes de IA usados hoy y, si Google ya agotó su cuota, cuánto esperar. */
export default route(["GET"], async (req, res) => {
  const userId = await requireUser(req);

  let used = 0;
  try {
    used = await messagesUsedToday(userId);
  } catch (err) {
    console.error("No se pudo leer ai_usage (¿falta ejecutar schema.sql?):", err);
  }

  res.status(200).json({ usage: snapshot(used), aiRetryAfterSeconds: aiQuotaWaitSeconds() });
});
