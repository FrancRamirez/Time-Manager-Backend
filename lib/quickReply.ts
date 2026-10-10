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

// Inglés
const THANKS_EN = /^(?:(?:ok|okay|great|perfect|awesome)\s+)?(?:(?:thanks|thank you|thx|ty)(?:\s+(?:so much|a lot|very much|a ton))?)(?:\s+(?:frami|for everything))?$/;
const GREETING_EN = /^(?:hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening)(?:\s+(?:there|frami))?$/;
const FAREWELL_EN = /^(?:bye|goodbye|good bye|see you|see you later|see ya|talk to you later|good night)(?:\s+frami)?$/;
const THANKS_REPLIES_EN = ["You're welcome! If you need anything else, I'm here.", "My pleasure! Let me know if there's anything else.", "Anytime! I'm here whenever you need me."];
const GREETING_REPLIES_EN = ["Hi! I'm Frami, your assistant. How can I help?", "Hi! How can I help you today?"];
const FAREWELL_REPLIES_EN = ["See you later! I'll be here when you need me.", "Bye! We can pick up whenever you like."];

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
  // En inglés se responde en inglés (según lo que escribió la persona).
  if (THANKS_EN.test(m)) return choose(THANKS_REPLIES_EN);
  if (GREETING_EN.test(m)) return choose(GREETING_REPLIES_EN);
  if (FAREWELL_EN.test(m)) return choose(FAREWELL_REPLIES_EN);
  return null;
}
