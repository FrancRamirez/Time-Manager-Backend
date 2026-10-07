// ---------------------------------------------------------------------------
// ¿La consulta es técnica o de cálculo? (razonamiento más profundo solo cuando hace falta)
// ---------------------------------------------------------------------------
//
// El nivel de razonamiento de Gemini ("thinking") mejora la exactitud en matemática, presupuestos y consultas de
// oficios, pero suma segundos. Para los pedidos de agenda ("mueve el dentista al viernes") alcanza con "low".
// Esto decide, SIN gastar una solicitud extra a la IA, cuándo conviene pensar más. Se prefiere errar hacia el
// lado de pensar de más (un poco más lento) antes que de menos (una cuenta mal hecha).

const norm = (s: string) =>
  s
    .slice(0, 2000)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Palabras que por sí solas marcan una consulta de cálculo, ciencia o de oficio/construcción. */
const STRONG =
  /\b(calcul\w*|presupuest\w*|formula\w*|ecuacion\w*|convert\w*|conversion|porcentaje|porciento|area|volumen|superficie|perimetro|hipotenusa|derivad\w*|integral\w*|raiz cuadrada|regla de tres|promedio|probabilidad|despej\w*|resolv\w*|resuelv\w*|factoriz\w*|trigonometr\w*|pitagoras|densidad|caudal|torque|amperaje|soldadur\w*|herreri\w*|hierro|varilla|planchuela|chapa|cano estructural|ladrillo\w*|hormigon|cemento|cableado|kva|kw)\b/;

/** Palabras de cantidad o precio: cuentan como técnicas solo si el mensaje trae algún número. */
const WEAK = /\b(cuanto|cuantos|cuanta|cuantas|vale|cuesta|pesa|pesan|mide|miden|rinde|lleva|necesito)\b/;

const DIMENSIONS = /\d+(?:[.,]\d+)?\s*(?:x|por)\s*\d+/;
const UNITS = /\d\s*(?:mm|cm|mts?|metros?|m2|m3|kg|kilos?|gramos?|litros?|lts?|ml|grados|pulgadas?|usd|pesos)\b|\d\s*[%°]|\$\s*\d/;
const OPERATORS = /\d\s*[+*×÷^]\s*\d/;

export function looksTechnical(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  const t = norm(text);
  if (STRONG.test(t)) return true;
  if (DIMENSIONS.test(t) || UNITS.test(t) || OPERATORS.test(t)) return true;
  return /\d/.test(t) && WEAK.test(t);
}

// --- Consultas de conocimiento (datos, explicaciones, dudas) ------------------------------------------------------
// Las respuestas generales también fallan en los detalles (un año, una cifra, un nombre parecido). Con más razonamiento
// y las reglas de precisión del prompt se reducen. No cuesta solicitudes extra: solo unos segundos más de espera.

/** Pedidos de la agenda o del teléfono: siguen por el camino rápido aunque empiecen con "qué" o "cuándo". */
const AGENDA =
  /\b(agenda\w*|evento\w*|reunion\w*|cita\w*|calendario|alarma\w*|temporizador\w*|recordator\w*|recuerda\w*|correo\w*|mail\w*|gmail|whatsapp|sms|mensaje\w*|llama\w*|llamada\w*|clima|pronostico|llover\w*|lluvia|paraguas|didi|mapa\w*|mueve\w*|cancela\w*|reprograma\w*|libre|ocupad\w*|salgo|tengo|hoy|manana|pasado manana|esta semana|proxima\w*|proximo\w*)\b/;

/** Preguntas típicas de conocimiento: qué es, por qué, quién fue, diferencia entre, cómo funciona, traducir... */
const KNOWLEDGE =
  /\b(que (?:es|son|significa\w*|quiere decir|pasa si|pasaria si)|por que|para que sirve\w*|como (?:funciona\w*|se (?:dice|escribe|llama|calcula|hace|usa|pronuncia)|puedo)|cual (?:es|fue|era|son|seria) (?:la|el|los|las) |cuales son|quien (?:fue|es|era|escribio|invento|descubrio|gano)|cuando (?:fue|nacio|murio|se (?:fundo|creo|inauguro))|donde (?:queda|esta|nacio|se encuentra)|en que (?:ano|pais|ciudad|continente|siglo)|capital de|diferencia\w* entre|explica\w*|define|definicion|significado|traduc\w*|sinonimo\w*|antonimo\w*|resumi\w*|resume\w*|historia de|cuantos (?:habitantes|anos|kilometros|paises|dias|meses|km)|cuanto (?:mide|pesa|dura|tarda)|es verdad que|es cierto que|es correcto|estoy en lo cierto|dosis|sintoma\w*|medicamento\w*|ibuprofeno|paracetamol|impuesto\w*|inflacion|interes\w*|jubilacion|monotributo|python|javascript|typescript|sql|excel|codigo|programacion|funcion de|error de)\b/;

export function looksKnowledge(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  const t = norm(text);
  if (AGENDA.test(t)) return false;
  if (KNOWLEDGE.test(t)) return true;
  // Una pregunta larga (5 palabras o más) que no es de agenda: se trata con más cuidado.
  return /\?\s*$/.test(t) && t.trim().split(/\s+/).length >= 5;
}

/**
 * Un seguimiento ("ahora hazlo con varilla del 8") no repite las palabras clave: también cuenta si alguno de los
 * dos últimos mensajes del usuario en esta conversación era técnico.
 */
export function needsDeepThinking(message: string, history: { role: string; content: string }[] = []): boolean {
  if (looksTechnical(message) || looksKnowledge(message)) return true;
  const lastUser = history.filter((m) => m.role === "user").slice(-2);
  return lastUser.some((m) => looksTechnical(m.content) || looksKnowledge(m.content));
}
