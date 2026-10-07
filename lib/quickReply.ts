// ---------------------------------------------------------------------------
// Respuestas locales para agradecimientos, saludos y despedidas (sin gastar cuota de IA)
// ---------------------------------------------------------------------------
//
// La cuota gratuita de Gemini es de pocas solicitudes por día y por modelo. Un "gracias" o un "hola" no
// necesita al modelo: se responde desde el servidor y NO descuenta del cupo del usuario.
//
// Es deliberadamente conservador: solo mensajes que son ÚNICAMENTE un agradecimiento, saludo o despedida.
// Cualquier otra cosa (incluidos "ok", "dale", "sí", que pueden ser la confirmación de algo que el asistente
// propuso, o un mensaje con una pregunta o un pedido) sigue yendo al modelo.

const THANKS = /^(?:(?:ok|oka|dale|genial|perfecto|listo|excelente|barbaro|buenisimo)\s+)?(?:(?:muchas|muchisimas|mil|un monton de)\s+)?gracias(?:\s+(?:por todo|frami))?$/;
const GREETING = /^(?:hola|holis?|hey|buenas|buen dia|buenos dias|buenas tardes|buenas noches)(?:\s+frami)?$/;
const FAREWELL = /^(?:chau|chao|adios|hasta luego|hasta manana|nos vemos|nos hablamos)(?:\s+frami)?$/;

/** Minúsculas, sin tildes, sin signos ni emojis, espacios simples. */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const THANKS_REPLIES = ["¡De nada! Si necesitas algo más, aquí estoy.", "¡Con gusto! Avísame si hay algo más.", "¡A ti! Aquí estoy para lo que necesites."];
const GREETING_REPLIES = ["¡Hola! Soy Frami, tu asistente. ¿En qué te ayudo?", "¡Hola! ¿En qué te ayudo hoy?"];
const FAREWELL_REPLIES = ["¡Hasta luego! Aquí estaré cuando me necesites.", "¡Nos vemos! Cuando quieras, seguimos."];

/** Texto de la respuesta local, o null si el mensaje debe ir al modelo. `pick` solo cambia en las pruebas. */
export function quickReply(message: string, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string | null {
  if (typeof message !== "string" || message.length > 40) return null;
  const m = normalize(message);
  if (!m || m.length > 32) return null;
  const choose = (list: string[]) => list[pick(list.length)] ?? list[0];
  if (THANKS.test(m)) return choose(THANKS_REPLIES);
  if (GREETING.test(m)) return choose(GREETING_REPLIES);
  if (FAREWELL.test(m)) return choose(FAREWELL_REPLIES);
  return null;
}
