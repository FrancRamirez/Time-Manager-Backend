// ---------------------------------------------------------------------------
// Mapas gratuitos con OpenStreetMap: lugares (Nominatim) y rutas (OSRM)
// ---------------------------------------------------------------------------
//
// Alternativa SIN clave y SIN costo a Google Maps (lib/maps.ts). Devuelve el mismo formato, así que
// las herramientas search_place y get_directions funcionan igual con cualquiera de los dos.
//
// Límites que hay que conocer:
//  - Nominatim (nominatim.openstreetmap.org): política de uso justo. Máximo 1 consulta por segundo,
//    User-Agent que identifique la app y nada de uso masivo. Aquí cada consulta del usuario hace 1 o
//    2 llamadas, separadas por >= 1 s. Si la app crece, conviene un Nominatim propio o un proveedor
//    comercial (el código solo cambia la URL: NOMINATIM_URL).
//  - Rutas (routing.openstreetmap.de, servidores de OSRM): sin tráfico (tiempo "libre de tráfico"),
//    sin transporte público. Auto, a pie y bicicleta.
//  - Atribución obligatoria (ODbL): "© colaboradores de OpenStreetMap". El resultado ya la incluye en
//    la nota que ve el modelo; la app puede mostrarla en Ajustes.
//
// Privacidad: igual que en Google Maps, la ubicación llega redondeada (~1 km), se usa solo para esta
// consulta y NO se guarda ni se escribe en los logs (tampoco las URL, que llevan coordenadas y textos).

import { tfetch } from "./timing";
import type { Coords } from "./weather";
import {
  MapsError,
  MAX_PLACE_RESULTS,
  cleanPlaceText,
  type FoundPlace,
  type RouteQuery,
  type RouteResult,
  type TravelMode,
} from "./maps";

const TIMEOUT_MS = 8_000;
/** Nominatim permite 1 consulta/s: se deja un margen. */
const NOMINATIM_GAP_MS = 1_100;

const nominatimBase = () => (process.env.NOMINATIM_URL?.trim() || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");

/** Perfiles de OSRM. El demo oficial (router.project-osrm.org) solo calcula en auto, por eso se usan estos. */
const OSRM_BASE: Record<Exclude<TravelMode, "transit">, string> = {
  drive: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  walk: "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
  bicycle: "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
};

/** Nominatim exige identificar la app; si se define OSM_CONTACT (email o web) se agrega. */
function userAgent(): string {
  const contact = process.env.OSM_CONTACT?.trim();
  return `TimeManager-Frami/1.0 (Framirez.dev${contact ? `; ${contact}` : ""})`;
}

export const OSM_ATTRIBUTION = "© colaboradores de OpenStreetMap";

// --- Control de ritmo (1 consulta por segundo a Nominatim) -----------------------------------

let lastNominatimAt = 0;

/** Espera lo que falte para respetar el intervalo mínimo. Solo dentro de esta instancia del servidor. */
async function nominatimTurn() {
  const now = Date.now();
  const wait = lastNominatimAt + NOMINATIM_GAP_MS - now;
  // Se reserva el turno antes de esperar, para que dos consultas simultáneas no salgan juntas.
  lastNominatimAt = Math.max(now, lastNominatimAt + NOMINATIM_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Solo para pruebas: evita esperas reales. */
export function _resetOsmThrottle() {
  lastNominatimAt = 0;
}
let testNoWait = false;
export function _setOsmNoWait(v: boolean) {
  testNoWait = v;
}

async function osmGet(url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await tfetch(url, {
      headers: { "user-agent": userAgent(), accept: "application/json", "accept-language": "es" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`${what}: sin respuesta`, (err as Error).message);
    throw new MapsError("network", "OpenStreetMap no respondió a tiempo.");
  }
  if (!res.ok) {
    // Solo el estado: la URL y la respuesta pueden llevar direcciones y coordenadas.
    console.error(`${what} falló: HTTP ${res.status}`);
    if (res.status === 400 || res.status === 404) throw new MapsError("not_found", "OpenStreetMap no pudo ubicar alguna dirección.");
    if (res.status === 429 || res.status === 403) throw new MapsError("quota", "Se superó el límite de consultas a OpenStreetMap.");
    throw new MapsError("other", "OpenStreetMap devolvió un error.");
  }
  try {
    return await res.json();
  } catch {
    throw new MapsError("other", "OpenStreetMap devolvió una respuesta ilegible.");
  }
}

async function nominatimGet(path: string, params: Record<string, string>, what: string): Promise<unknown> {
  if (!testNoWait) await nominatimTurn();
  const url = new URL(`${nominatimBase()}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return osmGet(url.toString(), what);
}

// --- Buscar lugares --------------------------------------------------------------------------

interface NominatimHit {
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: Record<string, string>;
  type?: string;
}

/** Distancia en km entre dos puntos (haversine). */
export function distanceKm(a: Coords, b: Coords): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Nombre corto + dirección legible a partir de un resultado de Nominatim. */
function toPlace(h: NominatimHit, near?: Coords): FoundPlace | null {
  const display = cleanPlaceText(h.display_name) ?? "";
  const name = cleanPlaceText(h.name) ?? cleanPlaceText(display.split(",")[0]) ?? "";
  if (!name && !display) return null;
  const lat = Number(h.lat);
  const lon = Number(h.lon);
  const km = near && Number.isFinite(lat) && Number.isFinite(lon) ? distanceKm(near, { lat, lon }) : undefined;
  return { name, address: display, ...(km !== undefined ? { distance_km: Math.round(km * 10) / 10 } : {}) };
}

/** Caja de ~±6 km alrededor de la ubicación, en el formato de Nominatim: lon_izq,lat_arriba,lon_der,lat_abajo. */
function viewbox(c: Coords, deg = 0.055): string {
  const lonDeg = deg / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180));
  return [c.lon - lonDeg, c.lat + deg, c.lon + lonDeg, c.lat - deg].map((n) => n.toFixed(5)).join(",");
}

/**
 * Busca lugares, direcciones, barrios o zonas por texto. Con `near` prioriza los cercanos: primero
 * dentro de ~6 km; si no hay nada, busca en general y ordena por cercanía.
 */
export async function searchPlacesOsm(query: string, near?: Coords): Promise<FoundPlace[]> {
  const base: Record<string, string> = {
    q: query,
    format: "jsonv2",
    limit: String(MAX_PLACE_RESULTS + 2), // un poco más para poder ordenar y recortar
    addressdetails: "0",
    "accept-language": "es",
  };
  const country = process.env.MAPS_REGION_CODE?.trim();
  if (country) base.countrycodes = country.toLowerCase();

  const run = async (extra: Record<string, string>) =>
    ((await nominatimGet("/search", { ...base, ...extra }, "Búsqueda de lugares (OSM)")) as NominatimHit[]) ?? [];

  let hits: NominatimHit[];
  if (near) {
    hits = await run({ viewbox: viewbox(near), bounded: "1" });
    if (!hits.length) hits = await run({ viewbox: viewbox(near, 0.3), bounded: "0" });
  } else {
    hits = await run({});
  }

  const places = (Array.isArray(hits) ? hits : []).map((h) => toPlace(h, near)).filter((p): p is FoundPlace => p !== null);
  if (near) places.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  return places.slice(0, MAX_PLACE_RESULTS);
}

/** Coordenadas de una dirección o lugar (para usarla como origen o destino de una ruta). */
async function geocode(text: string): Promise<Coords> {
  const params: Record<string, string> = { q: text, format: "jsonv2", limit: "1", "accept-language": "es" };
  const country = process.env.MAPS_REGION_CODE?.trim();
  if (country) params.countrycodes = country.toLowerCase();
  const hits = (await nominatimGet("/search", params, "Ubicar dirección (OSM)")) as NominatimHit[];
  const h = Array.isArray(hits) ? hits[0] : undefined;
  const lat = Number(h?.lat);
  const lon = Number(h?.lon);
  if (!h || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new MapsError("not_found", "OpenStreetMap no encontró esa dirección.");
  }
  return { lat, lon };
}

// --- Rutas -----------------------------------------------------------------------------------

/**
 * Distancia y tiempo de una ruta con OSRM. No hay tráfico ni transporte público: el tiempo es el de
 * la vía libre. Con `arriveByMs` calcula a qué hora salir (sumando 0 de tráfico: el prompt y la nota
 * piden agregar margen).
 */
export async function getRouteOsm(q: RouteQuery): Promise<RouteResult> {
  if (q.mode === "transit") {
    throw new MapsError("unsupported", "OpenStreetMap no calcula rutas en transporte público.");
  }
  const now = q.nowMs ?? Date.now();

  const from = "coords" in q.origin ? q.origin.coords : await geocode(q.origin.address);
  const to = await geocode(q.destination);

  const url = `${OSRM_BASE[q.mode]}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false&alternatives=false&steps=false`;
  const data = (await osmGet(url, "Ruta (OSM)")) as {
    code?: string;
    routes?: { duration?: number; distance?: number }[];
  };
  const route = data.routes?.[0];
  if (data.code !== "Ok" || !route || typeof route.duration !== "number" || route.duration < 0) {
    throw new MapsError("not_found", "No hay una ruta posible entre esos puntos.");
  }
  const durationSec = route.duration;

  const result: RouteResult = {
    durationSec,
    distanceM: typeof route.distance === "number" ? route.distance : 0,
    ...(q.departAtMs !== undefined && q.departAtMs > now + 60_000 ? { departAtMs: q.departAtMs } : {}),
  };
  if (q.arriveByMs !== undefined) {
    result.arriveByMs = q.arriveByMs;
    result.leaveByMs = q.arriveByMs - durationSec * 1000;
  }
  return result;
}
