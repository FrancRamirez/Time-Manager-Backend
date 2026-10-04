// ---------------------------------------------------------------------------
// Pronóstico (herramienta get_forecast) con Open-Meteo
// ---------------------------------------------------------------------------
//
// Open-Meteo no necesita clave. Su plan gratuito es solo para uso NO comercial y exige atribución
// (CC BY 4.0): si Time Manager pasa a cobrar hay que contratar su plan de pago y definir
// OPEN_METEO_API_KEY (el código cambia solo a los servidores de cliente).
//
// Privacidad: las coordenadas llegan redondeadas a 2 decimales (~1 km), se usan para esta consulta
// y no se guardan ni se registran en logs.

import { HttpError } from "./http";
import { tfetch } from "./timing";

/**
 * Con OPEN_METEO_API_KEY (plan de pago, obligatorio para uso comercial) se usan los servidores
 * "customer-*" con el parámetro apikey; sin ella, los gratuitos (solo uso no comercial).
 * La URL con la clave nunca se registra en logs.
 */
function openMeteoUrl(host: "api" | "geocoding-api", path: string): URL {
  const key = process.env.OPEN_METEO_API_KEY?.trim();
  const url = new URL(`https://${key ? "customer-" : ""}${host}.open-meteo.com${path}`);
  if (key) url.searchParams.set("apikey", key);
  return url;
}
const TIMEOUT_MS = 8_000;

export const MAX_FORECAST_DAYS = 7;
export const MAX_FORECAST_HOURS = 48;

export interface Coords {
  lat: number;
  lon: number;
}

/** ~1 km: suficiente para el clima y no revela dónde está el usuario con más precisión. */
export function roundCoord(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Valida lo que manda la app. Cualquier cosa rara = null (como si no hubiera ubicación). */
export function parseLocation(raw: unknown): Coords | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { lat, lon } = raw as Record<string, unknown>;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: roundCoord(lat), lon: roundCoord(lon) };
}

/** Códigos WMO que usa Open-Meteo -> texto en español. */
export function describeWeatherCode(code: unknown): string {
  const c = typeof code === "number" ? code : NaN;
  if (c === 0) return "despejado";
  if (c === 1) return "mayormente despejado";
  if (c === 2) return "parcialmente nublado";
  if (c === 3) return "nublado";
  if (c === 45 || c === 48) return "niebla";
  if (c >= 51 && c <= 55) return "llovizna";
  if (c === 56 || c === 57) return "llovizna helada";
  if (c === 61) return "lluvia débil";
  if (c === 63) return "lluvia moderada";
  if (c === 65) return "lluvia fuerte";
  if (c === 66 || c === 67) return "lluvia helada";
  if (c === 71) return "nevada débil";
  if (c === 73) return "nevada moderada";
  if (c === 75) return "nevada fuerte";
  if (c === 77) return "granos de nieve";
  if (c === 80) return "chubascos débiles";
  if (c === 81) return "chubascos moderados";
  if (c === 82) return "chubascos violentos";
  if (c === 85 || c === 86) return "chubascos de nieve";
  if (c === 95) return "tormenta";
  if (c === 96 || c === 99) return "tormenta con granizo";
  return "sin datos";
}

async function getJson(url: URL, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await tfetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.error(`${what}: sin respuesta`, (err as Error).message);
    throw new HttpError(502, "No se pudo consultar el servicio del clima. Intenta de nuevo en un momento.");
  }
  if (!res.ok) {
    // Sin la URL en el log: lleva las coordenadas.
    console.error(`${what} falló: HTTP ${res.status}`);
    throw new HttpError(502, "No se pudo consultar el servicio del clima. Intenta de nuevo en un momento.");
  }
  return res.json();
}

// --- Geocodificación (nombre de ciudad -> coordenadas) ---------------------------------------

export interface Place extends Coords {
  /** "Ciudad, Región, País" ya limpio para mostrar. */
  label: string;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const cleanLabel = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60);

interface GeoResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  country_code?: string;
  admin1?: string;
}

/**
 * Busca una ciudad. Open-Meteo solo compara el nombre, así que "Córdoba, Argentina" se separa:
 * se busca "Córdoba" y el resto se usa para elegir entre los resultados (país o provincia).
 */
export async function geocodeCity(input: unknown): Promise<Place | null> {
  if (typeof input !== "string") return null;
  const [namePart, ...hintParts] = input.split(",");
  const name = (namePart ?? "").trim().slice(0, 80);
  if (name.length < 2) return null;
  const hint = norm(hintParts.join(" "));

  const url = openMeteoUrl("geocoding-api", "/v1/search");
  url.searchParams.set("name", name);
  url.searchParams.set("count", hint ? "10" : "1");
  url.searchParams.set("language", "es");
  url.searchParams.set("format", "json");

  const data = (await getJson(url, "Geocodificación")) as { results?: GeoResult[] };
  const results = (data.results ?? []).filter(
    (r) => typeof r.latitude === "number" && typeof r.longitude === "number"
  );
  if (!results.length) return null;

  const matchesHint = (r: GeoResult) =>
    [r.country, r.country_code, r.admin1].some((v) => v && norm(v).includes(hint)) ||
    [r.country, r.admin1].some((v) => v && hint.includes(norm(v)));
  const pick = (hint && results.find(matchesHint)) || results[0];

  return {
    lat: roundCoord(pick.latitude as number),
    lon: roundCoord(pick.longitude as number),
    label: [pick.name, pick.admin1, pick.country]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map(cleanLabel)
      .filter((p, i, all) => all.indexOf(p) === i)
      .join(", "),
  };
}

// --- Pronóstico ----------------------------------------------------------------------------

interface OpenMeteoResponse {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    precipitation?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    precipitation?: (number | null)[];
    weather_code?: (number | null)[];
  };
  daily?: {
    time?: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
    precipitation_sum?: (number | null)[];
  };
}

const r1 = (n: number | null | undefined) => (typeof n === "number" ? Math.round(n * 10) / 10 : null);
const r0 = (n: number | null | undefined) => (typeof n === "number" ? Math.round(n) : null);

export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** Arma el resultado compacto (pocos tokens) que se le devuelve al modelo. */
export function compactForecast(
  data: OpenMeteoResponse,
  opts: { label?: string; days: number; hours: number }
) {
  const daily = data.daily ?? {};
  const days = (daily.time ?? []).slice(0, opts.days).map((date, i) => ({
    date,
    conditions: describeWeatherCode(daily.weather_code?.[i]),
    min_c: r0(daily.temperature_2m_min?.[i]),
    max_c: r0(daily.temperature_2m_max?.[i]),
    rain_chance_pct: r0(daily.precipitation_probability_max?.[i]),
    rain_mm: r1(daily.precipitation_sum?.[i]),
  }));

  let hourly:
    | { time: string; temp_c: number | null; rain_chance_pct: number | null; rain_mm: number | null; conditions: string }[]
    | undefined;
  if (opts.hours > 0 && data.hourly?.time) {
    // `time` viene en hora local del lugar (timezone=auto): se parte desde la hora actual de ese lugar.
    const nowHour = (data.current?.time ?? "").slice(0, 13);
    let start = data.hourly.time.findIndex((t) => t.slice(0, 13) >= nowHour);
    if (start < 0) start = 0;
    hourly = data.hourly.time.slice(start, start + opts.hours).map((time, k) => {
      const i = start + k;
      return {
        time,
        temp_c: r0(data.hourly?.temperature_2m?.[i]),
        rain_chance_pct: r0(data.hourly?.precipitation_probability?.[i]),
        rain_mm: r1(data.hourly?.precipitation?.[i]),
        conditions: describeWeatherCode(data.hourly?.weather_code?.[i]),
      };
    });
  }

  const cur = data.current;
  return {
    location: opts.label,
    timezone: data.timezone,
    now: cur
      ? {
          time: cur.time,
          temp_c: r0(cur.temperature_2m),
          feels_like_c: r0(cur.apparent_temperature),
          conditions: describeWeatherCode(cur.weather_code),
          rain_mm: r1(cur.precipitation),
        }
      : undefined,
    daily: days,
    ...(hourly ? { hourly } : {}),
    note: "Las horas están en la hora local del lugar consultado. Datos de Open-Meteo.com.",
  };
}

export async function fetchForecast(
  at: Coords,
  opts: { label?: string; days: number; hours: number }
) {
  const days = clampInt(opts.days, 1, MAX_FORECAST_DAYS, 3);
  const hours = clampInt(opts.hours, 0, MAX_FORECAST_HOURS, 0);

  const url = openMeteoUrl("api", "/v1/forecast");
  url.searchParams.set("latitude", String(roundCoord(at.lat)));
  url.searchParams.set("longitude", String(roundCoord(at.lon)));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weather_code,precipitation"
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum"
  );
  if (hours > 0) {
    url.searchParams.set("hourly", "temperature_2m,precipitation_probability,precipitation,weather_code");
  }
  // El horario por horas empieza a las 00:00 de hoy: se piden los días necesarios para cubrir `hours`.
  const needed = hours > 0 ? Math.ceil((hours + 24) / 24) : 1;
  url.searchParams.set("forecast_days", String(Math.min(MAX_FORECAST_DAYS, Math.max(days, needed))));

  const data = (await getJson(url, "Pronóstico")) as OpenMeteoResponse;
  return compactForecast(data, { label: opts.label, days, hours });
}
