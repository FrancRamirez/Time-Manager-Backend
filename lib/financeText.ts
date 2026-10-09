// ---------------------------------------------------------------------------
// ¿El mensaje pide una cotización o una conversión de monedas? (lógica pura, sin red)
// ---------------------------------------------------------------------------
//
// Se decide por el texto, sin gastar una solicitud a la IA. Si hay una cantidad y dos monedas ("100 usd a pesos
// al blue", "cuánto son 50000 pesos en euros") el SERVIDOR hace la cuenta con las cotizaciones del momento:
// los modelos de lenguaje se equivocan en la multiplicación y en cuál lado de la cotización (compra o venta) usar.
// Si no se puede interpretar con seguridad, solo se adelantan las cotizaciones y el modelo decide.

export type ArType = "oficial" | "blue" | "bolsa" | "contadoconliqui" | "tarjeta" | "mayorista" | "cripto";
export const AR_TYPES: readonly ArType[] = ["oficial", "blue", "bolsa", "contadoconliqui", "tarjeta", "mayorista", "cripto"];

export interface FinanceRequest {
  /** Conversión interpretada (solo si hay cantidad y se entiende de qué moneda a cuál). */
  convert?: { amount: number; from: string; to: string };
  /** Tipo de dólar nombrado en el mensaje (blue, mep...). null = no dijo. */
  arsType: ArType | null;
}

const norm = (s: string) =>
  s
    .slice(0, 2000)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Alias (ya sin tildes y en minúscula) -> código ISO. Los más específicos primero ("peso chileno" antes que "peso"). */
const CURRENCY_ALIASES: [string, string][] = [
  ["pesos? argentin\\w*", "ARS"],
  ["pesos? chilen\\w*", "CLP"],
  ["pesos? uruguay\\w*", "UYU"],
  ["pesos? mexican\\w*", "MXN"],
  ["pesos? colombian\\w*", "COP"],
  ["francos? suizos?", "CHF"],
  ["dolar(?:es)? canadiens\\w*", "CAD"],
  ["dolar(?:es)? australian\\w*", "AUD"],
  ["dolar(?:es)?(?: estadounidenses?| americanos?| usa)?", "USD"],
  ["u\\$s", "USD"],
  ["us\\$", "USD"],
  ["usd", "USD"],
  ["euros?", "EUR"],
  ["eur", "EUR"],
  ["pesos?", "ARS"],
  ["ars", "ARS"],
  ["real(?:es)?", "BRL"],
  ["brl", "BRL"],
  ["clp", "CLP"],
  ["uyu", "UYU"],
  ["mxn", "MXN"],
  ["cop", "COP"],
  ["libras?(?: esterlinas?)?", "GBP"],
  ["gbp", "GBP"],
  ["yenes?|yen", "JPY"],
  ["jpy", "JPY"],
  ["yuanes?|yuan", "CNY"],
  ["cny", "CNY"],
  ["cad", "CAD"],
  ["aud", "AUD"],
  ["chf", "CHF"],
  ["guaranies|guarani|pyg", "PYG"],
  ["soles?|pen", "PEN"],
  ["bolivianos?|bob", "BOB"],
];

const ALIAS_RE = CURRENCY_ALIASES.map(([pattern, code]) => ({ re: new RegExp(`(?<![a-z])(?:${pattern})(?![a-z])`, "g"), code }));

/** Código ISO a partir de lo que escribió el usuario o el modelo ("dólares", "usd", "EUR"). null = no se reconoce. */
export function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = norm(raw).trim();
  if (!t) return null;
  if (/^[a-z]{3}$/.test(t)) return t.toUpperCase();
  for (const { re, code } of ALIAS_RE) {
    re.lastIndex = 0;
    const m = re.exec(t);
    if (m && m[0] === t) return code;
  }
  return null;
}

/** Tipo de dólar argentino a partir del texto (blue, mep, ccl, tarjeta...). null = no se reconoce. */
export function normalizeArType(raw: unknown): ArType | null {
  if (typeof raw !== "string") return null;
  const t = norm(raw);
  if (/\b(blue|paralelo|informal)\b/.test(t)) return "blue";
  if (/\b(mep|bolsa)\b/.test(t)) return "bolsa";
  if (/\b(ccl|contado con liqui\w*|contadoconliqui|liqui)\b/.test(t)) return "contadoconliqui";
  if (/\b(tarjeta|turista|solidario)\b/.test(t)) return "tarjeta";
  if (/\b(mayorista)\b/.test(t)) return "mayorista";
  if (/\b(cripto|usdt)\b/.test(t)) return "cripto";
  if (/\b(oficial|banco|bna)\b/.test(t)) return "oficial";
  return null;
}

/** "1.500,50" / "1,500.50" / "1500" / "2.500" -> número. null = no es un número razonable. */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/[^\d.,]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    s = s.split(thousands).join("").replace(decimal, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    const groups = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3 && parts[0] !== "0");
    s = groups ? parts.join("") : `${parts[0]}.${parts[1]}`;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 1e15 ? n : null;
}

interface Mention {
  code: string;
  index: number;
  end: number;
}

function mentions(n: string): Mention[] {
  const out: Mention[] = [];
  for (const { re, code } of ALIAS_RE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(n))) out.push({ code, index: m.index, end: m.index + m[0].length });
  }
  // Se descartan las menciones contenidas en otra más larga ("pesos argentinos" ya incluye a "pesos").
  const kept = out.filter((a) => !out.some((b) => b !== a && b.index <= a.index && b.end >= a.end && b.end - b.index > a.end - a.index));
  const seen = new Set<string>();
  return kept
    .sort((a, b) => a.index - b.index)
    .filter((m) => (seen.has(`${m.index}`) ? false : (seen.add(`${m.index}`), true)));
}

/** Palabras que por sí solas indican una consulta de cotización. */
const STRONG = /\b(dolar\w*|blue|mep|ccl|contado con liqui\w*|cotizacion\w*|cotiza\w*|tipo de cambio|divisas?|cripto|usdt)\b/;
const CONVERT_WORDS = /\b(convert\w*|cambi\w*|equival\w*|cuanto (?:son|es|serian|seria|saldria|salen|sale|valen|vale|me dan|dan)|a cuanto (?:equivale|esta|cotiza)|pasa\w*|en que se transforma)\b/;
const NOT_FINANCE = /\b(dolar(?:es)? (?:de|del) (?:ferretero|herrer)\w*)\b/;

export function parseFinanceRequest(message: string): FinanceRequest | null {
  if (typeof message !== "string" || !message.trim()) return null;
  const n = norm(message);
  if (NOT_FINANCE.test(n)) return null;
  const found = mentions(n);
  const distinct = new Set(found.map((m) => m.code));
  const strong = STRONG.test(n);
  const wantsConversion = CONVERT_WORDS.test(n) && distinct.size >= 2;
  const bareEuro = distinct.has("EUR") && /\b(cuanto|a cuanto|cotiza\w*|esta el|vale el)\b/.test(n);
  if (!found.length || !(strong || wantsConversion || bareEuro)) return null;

  const request: FinanceRequest = { arsType: normalizeArType(n) };

  // Cantidad pegada a una moneda: "100 usd", "$5000", "50.000 pesos", "2 mil euros" (mil no se interpreta: queda sin convertir).
  const numberRe = /(?:(\$|u\$s|us\$)\s*)?(\d[\d.,]*)\s*(k\b)?/g;
  let m: RegExpExecArray | null;
  while ((m = numberRe.exec(n))) {
    const amount = parseAmount(m[2]);
    if (amount === null) continue;
    const mult = m[3] ? 1000 : 1;
    const afterIdx = m.index + m[0].length;
    const next = found.find((f) => f.index >= afterIdx - 1 && f.index - afterIdx <= 2);
    const symbol = m[1] ? (m[1] === "$" ? "ARS" : "USD") : null;
    const from = symbol ?? next?.code ?? null;
    if (!from) continue;
    const startedAfter = symbol ? afterIdx : (next?.end ?? afterIdx);
    // Moneda de destino: la primera otra moneda que aparece después ("a pesos", "en euros").
    const target = found.find((f) => f.index >= startedAfter && f.code !== from);
    let to = target?.code ?? null;
    if (!to) to = from === "USD" ? "ARS" : from === "ARS" && /dolar|usd|blue|mep|ccl/.test(n) ? "USD" : null;
    if (to) request.convert = { amount: amount * mult, from, to };
    break;
  }
  // "¿a cuánto está el euro?": sin cantidad, se toma 1 unidad de la moneda nombrada contra el peso.
  if (!request.convert) {
    const other = found.find((f) => f.code !== "ARS" && f.code !== "USD");
    if (other) request.convert = { amount: 1, from: other.code, to: "ARS" };
  }
  return request;
}
