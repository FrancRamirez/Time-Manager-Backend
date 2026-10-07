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

/**
 * Un seguimiento ("ahora hazlo con varilla del 8") no repite las palabras clave: también cuenta si alguno de los
 * dos últimos mensajes del usuario en esta conversación era técnico.
 */
export function needsDeepThinking(message: string, history: { role: string; content: string }[] = []): boolean {
  if (looksTechnical(message)) return true;
  const lastUser = history.filter((m) => m.role === "user").slice(-2);
  return lastUser.some((m) => looksTechnical(m.content));
}
