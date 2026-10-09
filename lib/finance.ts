// ---------------------------------------------------------------------------
// Cotizaciones en tiempo real (herramienta "get_exchange_rates")
// ---------------------------------------------------------------------------
//
// Fuentes gratuitas y sin clave (el proyecto no paga servicios por ahora):
//   - Dólar en Argentina (oficial, blue, MEP, CCL, tarjeta, mayorista, cripto): dolarapi.com
//   - Monedas del mundo contra el dólar: Frankfurter (tipos del Banco Central Europeo, se actualiza cada día hábil)
//     y, solo para las monedas que Frankfurter no tiene, open.er-api.com (una vez por día; pide dar el crédito).
// Las cuentas las hace el SERVIDOR (no el modelo): se evita el error de multiplicar y el de usar el lado equivocado
// de la cotización. Se guarda en memoria unos minutos para cuidar a los servicios y acelerar las respuestas.

import { tfetch } from "./timing";
import { AR_TYPES, normalizeArType, normalizeCurrency, type ArType, type FinanceRequest } from "./financeText";

const TIMEOUT_MS = 6_000;
const AR_CACHE_MS = 5 * 60_000;
const FX_CACHE_MS = 30 * 60_000;
/** Si el servicio falla, se usan datos viejos de hasta este tiempo (y se avisa). */
const STALE_MAX_MS = 3 * 60 * 60_000;

export const AR_NAMES: Record<ArType, string> = {
  oficial: "Oficial",
  blue: "Blue",
  bolsa: "MEP (Bolsa)",
  contadoconliqui: "CCL (Contado con liquidación)",
  tarjeta: "Tarjeta (con recargos de impuestos)",
  mayorista: "Mayorista",
  cripto: "Cripto",
};

export interface ArQuote {
  type: ArType;
  name: string;
  /** Precio al que la casa COMPRA dólares (lo que recibes si vendes). */
  buy: number | null;
  /** Precio al que la casa VENDE dólares (lo que pagas si compras). */
  sell: number | null;
  updated: string | null;
}

interface Cached<T> {
  at: number;
  value: T;
}

let arCache: Cached<ArQuote[]> | null = null;
let fxCache: Cached<{ rates: Record<string, number>; date: string | null; sources: string[] }> | null = null;
let erCache: Cached<{ rates: Record<string, number>; date: string | null }> | null = null;

/** Solo para las pruebas. */
export function clearFinanceCache() {
  arCache = null;
  fxCache = null;
  erCache = null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await tfetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

// --- Dólar en Argentina -----------------------------------------------------------------------

export async function fetchArDollars(): Promise<{ quotes: ArQuote[]; stale: boolean }> {
  const now = Date.now();
  if (arCache && now - arCache.at < AR_CACHE_MS) return { quotes: arCache.value, stale: false };
  try {
    const data = await getJson("https://dolarapi.com/v1/dolares");
    if (!Array.isArray(data)) throw new Error("respuesta inesperada");
    const quotes: ArQuote[] = [];
    for (const row of data as Record<string, unknown>[]) {
      const type = typeof row?.casa === "string" ? (AR_TYPES as readonly string[]).includes(row.casa) ? (row.casa as ArType) : null : null;
      if (!type) continue;
      quotes.push({
        type,
        name: AR_NAMES[type],
        buy: num(row.compra),
        sell: num(row.venta),
        updated: typeof row.fechaActualizacion === "string" ? row.fechaActualizacion : null,
      });
    }
    if (!quotes.length) throw new Error("sin cotizaciones");
    arCache = { at: now, value: quotes };
    return { quotes, stale: false };
  } catch (err) {
    console.error("Cotización del dólar en Argentina falló:", (err as Error).message);
    if (arCache && now - arCache.at < STALE_MAX_MS) return { quotes: arCache.value, stale: true };
    throw err;
  }
}

// --- Monedas del mundo ------------------------------------------------------------------------

async function fetchFrankfurter() {
  const data = (await getJson("https://api.frankfurter.dev/v1/latest?base=USD")) as { rates?: Record<string, unknown>; date?: unknown };
  const rates: Record<string, number> = { USD: 1 };
  for (const [code, v] of Object.entries(data.rates ?? {})) {
    const n = num(v);
    if (n && /^[A-Z]{3}$/.test(code)) rates[code] = n;
  }
  if (Object.keys(rates).length < 5) throw new Error("respuesta inesperada");
  return { rates, date: typeof data.date === "string" ? data.date : null };
}

async function fetchErApi() {
  const data = (await getJson("https://open.er-api.com/v6/latest/USD")) as { result?: unknown; rates?: Record<string, unknown>; time_last_update_utc?: unknown };
  if (data.result !== "success") throw new Error("respuesta inesperada");
  const rates: Record<string, number> = { USD: 1 };
  for (const [code, v] of Object.entries(data.rates ?? {})) {
    const n = num(v);
    if (n && /^[A-Z]{3}$/.test(code)) rates[code] = n;
  }
  return { rates, date: typeof data.time_last_update_utc === "string" ? data.time_last_update_utc : null };
}

/** Cuántas unidades de cada moneda equivalen a 1 USD. `need` = monedas que el pedido necesita. */
export async function fetchUsdRates(need: string[]): Promise<{ rates: Record<string, number>; date: string | null; sources: string[]; stale: boolean }> {
  const now = Date.now();
  let base = fxCache && now - fxCache.at < FX_CACHE_MS ? fxCache.value : null;
  let stale = false;
  if (!base) {
    try {
      const f = await fetchFrankfurter();
      base = { rates: f.rates, date: f.date, sources: ["Frankfurter (Banco Central Europeo)"] };
      fxCache = { at: now, value: base };
    } catch (err) {
      console.error("Frankfurter falló:", (err as Error).message);
      if (fxCache && now - fxCache.at < STALE_MAX_MS) {
        base = fxCache.value;
        stale = true;
      }
    }
  }
  const rates = { ...(base?.rates ?? {}) };
  const sources = [...(base?.sources ?? [])];
  let date = base?.date ?? null;

  const missing = need.filter((c) => c !== "ARS" && !rates[c]);
  if (missing.length || !base) {
    try {
      let er = erCache && now - erCache.at < FX_CACHE_MS ? erCache.value : null;
      if (!er) {
        er = await fetchErApi();
        erCache = { at: now, value: er };
      }
      for (const c of missing.length ? missing : Object.keys(er.rates)) if (er.rates[c] && !rates[c]) rates[c] = er.rates[c];
      if (!base) date = er.date;
      sources.push("ExchangeRate-API (exchangerate-api.com)");
    } catch (err) {
      console.error("ExchangeRate-API falló:", (err as Error).message);
    }
  }
  return { rates, date, sources, stale };
}

// --- Conversión exacta (pura: se puede probar sin red) -----------------------------------------

export interface ConvertResult {
  amount: number;
  from: string;
  to: string;
  result: number;
  /** Cómo leer `result` (ver el lado de la cotización que se usó). */
  result_meaning: string;
  rate_used: string;
  alternative?: { result: number; meaning: string };
  ars_type?: ArType;
}

const round = (x: number) => (Math.abs(x) >= 1 ? Math.round(x * 100) / 100 : Math.round(x * 10000) / 10000);
const money = (x: number) => x.toLocaleString("es-AR", { maximumFractionDigits: 4 });

/**
 * Reglas con el dólar de Argentina (compra = lo que paga la casa; venta = lo que cobra):
 *  - Vender dólares / otra moneda por pesos: recibes al precio de COMPRA. Alternativa: venta.
 *  - Comprar dólares / otra moneda con pesos: pagas al precio de VENTA. Alternativa: compra.
 * Otras monedas con pesos pasan por el dólar (otra moneda -> USD -> pesos): es una estimación.
 */
export function convertCurrency(input: {
  amount: number;
  from: string;
  to: string;
  arsType: ArType;
  quotes: ArQuote[];
  usdRates: Record<string, number>;
}): ConvertResult | { error: string } {
  const { amount, from, to, arsType, quotes, usdRates } = input;
  if (!(amount > 0) || !Number.isFinite(amount)) return { error: "La cantidad tiene que ser un número mayor que cero." };
  if (from === to) return { amount, from, to, result: round(amount), result_meaning: "Es la misma moneda.", rate_used: "1" };

  const perUsd = (code: string) => (code === "USD" ? 1 : usdRates[code]);

  if (from !== "ARS" && to !== "ARS") {
    const a = perUsd(from);
    const b = perUsd(to);
    if (!a || !b) return { error: `No tengo cotización de ${!a ? from : to} en este momento.` };
    const rate = b / a;
    return { amount, from, to, result: round(amount * rate), result_meaning: "Cotización de referencia (mercado), no incluye comisiones.", rate_used: `1 ${from} = ${money(rate)} ${to}` };
  }

  const q = quotes.find((x) => x.type === arsType);
  if (!q || !q.buy || !q.sell) return { error: `No tengo la cotización del dólar ${AR_NAMES[arsType]} en este momento.` };

  if (to === "ARS") {
    const unit = perUsd(from);
    if (!unit) return { error: `No tengo cotización de ${from} en este momento.` };
    const usd = amount / unit;
    return {
      amount, from, to, ars_type: arsType,
      result: round(usd * q.buy),
      result_meaning: `Pesos que recibirías al VENDER (dólar ${AR_NAMES[arsType]}, precio de compra de la casa: $${money(q.buy)}).`,
      rate_used: from === "USD" ? `1 USD = $${money(q.buy)} (compra)` : `1 ${from} = ${money(usd / amount * q.buy)} ARS (vía dólar ${AR_NAMES[arsType]})`,
      alternative: { result: round(usd * q.sell), meaning: `Pesos que costaría COMPRAR esa cantidad (precio de venta de la casa: $${money(q.sell)}).` },
    };
  }

  // from === "ARS"
  const unit = perUsd(to);
  if (!unit) return { error: `No tengo cotización de ${to} en este momento.` };
  const usdBuy = amount / q.sell;
  const usdSell = amount / q.buy;
  return {
    amount, from, to, ars_type: arsType,
    result: round(usdBuy * unit),
    result_meaning: `${to === "USD" ? "Dólares" : to} que podrías COMPRAR con esos pesos (dólar ${AR_NAMES[arsType]}, precio de venta de la casa: $${money(q.sell)}).`,
    rate_used: to === "USD" ? `1 USD = $${money(q.sell)} (venta)` : `1 ${to} = ${money(q.sell / unit)} ARS (vía dólar ${AR_NAMES[arsType]})`,
    alternative: { result: round(usdSell * unit), meaning: `Lo que obtendrías si la casa te comprara a su precio de compra ($${money(q.buy)}).` },
  };
}

// --- Herramienta -----------------------------------------------------------------------------

const SOURCES_AR = "dolarapi.com";

/** Resultado de la herramienta get_exchange_rates (nunca lanza: los errores van en `error`). */
export async function runExchangeRates(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const from = args.from === undefined ? null : normalizeCurrency(args.from);
  const to = args.to === undefined ? null : normalizeCurrency(args.to);
  if ((args.from !== undefined && !from) || (args.to !== undefined && !to)) {
    return { error: "No reconozco la moneda. Usa códigos de tres letras (USD, EUR, ARS, BRL, GBP...)." };
  }
  const rawAmount = args.amount === undefined || args.amount === null ? 1 : Number(args.amount);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0 || rawAmount >= 1e15) {
    return { error: "La cantidad tiene que ser un número mayor que cero." };
  }
  const requestedType = args.ars_type === undefined ? null : normalizeArType(args.ars_type);
  if (args.ars_type !== undefined && !requestedType) {
    return { error: `Tipo de dólar no reconocido. Opciones: ${AR_TYPES.join(", ")}.` };
  }
  const arsType = requestedType ?? "oficial";
  const hasPair = !!(from && to);
  const arsInvolved = from === "ARS" || to === "ARS";
  const wantsAr = args.include_argentina === true || arsInvolved || !hasPair;

  const out: Record<string, unknown> = {};
  const sources: string[] = [];
  const notes: string[] = [];
  let quotes: ArQuote[] = [];

  if (wantsAr) {
    try {
      const ar = await fetchArDollars();
      quotes = ar.quotes;
      out.argentina_dollars = ar.quotes.map((q) => ({ type: q.type, name: q.name, buy: q.buy, sell: q.sell, updated: q.updated }));
      sources.push(SOURCES_AR);
      if (ar.stale) notes.push("Los datos del dólar en Argentina pueden estar desactualizados: el servicio no respondió y se usó la última consulta.");
    } catch {
      if (arsInvolved || !hasPair) return { error: "No pude consultar la cotización del dólar en Argentina en este momento. Intenta de nuevo en un rato." };
      notes.push("No se pudo consultar el dólar de Argentina.");
    }
  }

  if (hasPair) {
    const need = [from!, to!].filter((c) => c !== "ARS" && c !== "USD");
    const needsFx = !(arsInvolved && need.length === 0);
    let usdRates: Record<string, number> = { USD: 1 };
    if (needsFx) {
      const fx = await fetchUsdRates(need);
      usdRates = fx.rates;
      sources.push(...fx.sources);
      if (fx.date) out.rates_date = fx.date;
      if (fx.stale) notes.push("Las cotizaciones internacionales pueden estar desactualizadas: el servicio no respondió y se usó la última consulta.");
    }
    const conv = convertCurrency({ amount: rawAmount, from: from!, to: to!, arsType, quotes, usdRates });
    if ("error" in conv) return { ...out, error: conv.error };
    out.conversion = conv;
    if (arsInvolved && !requestedType) {
      notes.push("No se indicó el tipo de dólar: se usó el OFICIAL. Dile al usuario cuál usaste y ofrece el blue, MEP u otro (están en argentina_dollars).");
    }
    if (arsInvolved && from !== "USD" && to !== "USD") notes.push("La conversión con pesos pasa por el dólar: es una estimación.");
  }

  out.as_of = new Date().toISOString();
  out.sources = [...new Set(sources)];
  out.notes = notes.concat("Son cotizaciones de referencia, no una oferta: en una casa de cambio o banco el precio real puede variar.");
  return out;
}

// --- Datos que se adelantan al modelo (preload) -------------------------------------------------

/** Trae las cotizaciones del pedido y, si el mensaje trae cantidad y monedas, las conversiones ya calculadas. Nunca lanza. */
export async function runFinancePreload(req: FinanceRequest): Promise<Record<string, unknown> | null> {
  const tool = async (a: Record<string, unknown>) => runExchangeRates(a);
  const results: Record<string, unknown>[] = [];
  if (req.convert) {
    const { amount, from, to } = req.convert;
    const involvesArs = from === "ARS" || to === "ARS";
    // Sin tipo nombrado, con pesos de por medio se calculan el oficial y el blue (los dos más preguntados).
    const types: (ArType | null)[] = involvesArs && !req.arsType ? ["oficial", "blue"] : [req.arsType];
    for (const t of types) {
      const r = await tool({ amount, from, to, ...(t ? { ars_type: t } : {}) });
      if (!("error" in r)) results.push(r);
    }
    if (!results.length) return null;
    const first = results[0];
    return {
      argentina_dollars: first.argentina_dollars,
      conversions: results.map((r) => r.conversion),
      rates_date: first.rates_date,
      sources: first.sources,
      notes: first.notes,
      as_of: first.as_of,
    };
  }
  const r = await tool({ include_argentina: true });
  return "error" in r ? null : r;
}
