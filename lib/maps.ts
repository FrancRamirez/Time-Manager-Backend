// ---------------------------------------------------------------------------
// Google Maps: lugares, rutas y tiempos de viaje (herramientas search_place, get_directions y
// open_maps_route)
// ---------------------------------------------------------------------------
//
// Usa Places API (New) para buscar lugares y Routes API para distancia, tiempo y tráfico. Ambas
// necesitan GOOGLE_MAPS_API_KEY (un proyecto de GCP con facturación vinculada: Google da un cupo
// gratis por SKU y cobra solo lo que lo supere; conviene fijar cuotas diarias en la consola).
// Abrir la ruta en la app de Google Maps (open_maps_route) NO usa la API ni la clave.
//
// Privacidad: la ubicación del usuario llega redondeada (~1 km) y solo se usa para esta consulta;
// ni las coordenadas ni los destinos se guardan ni se registran en logs (tampoco las URL).

import { tfetch } from "./timing";
import type { Coords } from "./weather";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 8_000;

export type TravelMode = "drive" | "walk" | "bicycle" | "transit";
export const TRAVEL_MODES: TravelMode[] = ["drive", "walk", "bicycle", "transit"];

export const MODE_LABEL: Record<TravelMode, string> = {
  drive: "en auto",
  walk: "a pie",
  bicycle: "en bicicleta",
  transit: "en transporte público",
};

const GOOGLE_MODE: Record<TravelMode, string> = {
  drive: "DRIVE",
  walk: "WALK",
  bicycle: "BICYCLE",
  transit: "TRANSIT",
};

/** Modo desconocido o ausente = auto. */
export function parseTravelMode(raw: unknown): TravelMode {
  return TRAVEL_MODES.find((m) => m === raw) ?? "drive";
}

/** Texto de un lugar o dirección: sin saltos de línea ni caracteres de control, de 2 a 200 caracteres. */
export function cleanPlaceText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 2 && s.length <= 200 ? s : null;
}

/** Quién resuelve una consulta de mapas. */
export type MapsProviderName = "google" | "osm";

export function mapsConfigured(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY?.trim();
}

/** Por qué falló una consulta a Google Maps (para explicarlo; nunca lleva datos del usuario). */
export type MapsErrorKind = "not_configured" | "not_found" | "quota" | "config" | "network" | "unsupported" | "other";

export class MapsError extends Error {
  constructor(
    public kind: MapsErrorKind,
    message: string
  ) {
    super(message);
    this.name = "MapsError";
  }
}

async function mapsPost(url: string, fieldMask: string, body: unknown, what: string): Promise<unknown> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new MapsError("not_configured", "Falta GOOGLE_MAPS_API_KEY");

  let res: Response;
  try {
    res = await tfetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`${what}: sin respuesta`, (err as Error).message);
    throw new MapsError("network", "Google Maps no respondió a tiempo.");
  }
  if (!res.ok) {
    // Solo el estado: la URL, el cuerpo y la respuesta pueden llevar direcciones y coordenadas.
    console.error(`${what} falló: HTTP ${res.status}`);
    if (res.status === 400 || res.status === 404) throw new MapsError("not_found", "Google Maps no pudo ubicar alguna dirección.");
    if (res.status === 429) throw new MapsError("quota", "Se superó el límite de consultas a Google Maps.");
    if (res.status === 401 || res.status === 403) throw new MapsError("config", "La clave de Google Maps no tiene permiso.");
    throw new MapsError("other", "Google Maps devolvió un error.");
  }
  return res.json();
}

// --- Buscar lugares ------------------------------------------------------------------------

export interface FoundPlace {
  name: string;
  address: string;
  /** Distancia en línea recta desde el usuario (solo si se buscó "cerca" y el proveedor da coordenadas). */
  distance_km?: number;
}

export const MAX_PLACE_RESULTS = 3;

/** Busca lugares por texto ("farmacia", "Hospital Italiano, Córdoba"). Con `near` prioriza los cercanos. */
export async function searchPlaces(query: string, near?: Coords): Promise<FoundPlace[]> {
  const body: Record<string, unknown> = {
    textQuery: query,
    languageCode: "es",
    pageSize: MAX_PLACE_RESULTS,
  };
  const region = process.env.MAPS_REGION_CODE?.trim();
  if (region) body.regionCode = region;
  if (near) {
    body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: 5000 } };
  }
  // Máscara mínima: solo se pagan (y se reciben) nombre, dirección y ubicación.
  const data = (await mapsPost(
    PLACES_URL,
    "places.displayName,places.formattedAddress",
    body,
    "Búsqueda de lugares"
  )) as { places?: { displayName?: { text?: string }; formattedAddress?: string }[] };

  return (data.places ?? [])
    .map((p) => ({
      name: cleanPlaceText(p.displayName?.text) ?? "",
      address: cleanPlaceText(p.formattedAddress) ?? "",
    }))
    .filter((p) => p.name || p.address)
    .slice(0, MAX_PLACE_RESULTS);
}

// --- Rutas ---------------------------------------------------------------------------------

/** Origen o destino: un texto (Google lo geocodifica) o unas coordenadas. */
export type Waypoint = { address: string } | { coords: Coords };

export interface RouteQuery {
  origin: Waypoint;
  destination: string;
  mode: TravelMode;
  /** Salida (UTC ms). Sin valor, o ya pasada: "ahora". Solo cuenta para auto y transporte público. */
  departAtMs?: number;
  /** Hora a la que quiere llegar (UTC ms): se calcula a qué hora salir. */
  arriveByMs?: number;
  /** Solo para pruebas. */
  nowMs?: number;
}

export interface RouteResult {
  /** Duración estimada (con tráfico si es en auto). */
  durationSec: number;
  /** Duración sin tráfico (solo en auto). */
  typicalSec?: number;
  distanceM: number;
  /** Nombre corto de la ruta ("Av. Colón"), si Google lo da. */
  via?: string;
  /** Hora de salida considerada (UTC ms); sin valor = ahora. */
  departAtMs?: number;
  /** Con arriveByMs: a qué hora hay que salir. */
  leaveByMs?: number;
  arriveByMs?: number;
}

function waypointBody(w: Waypoint) {
  return "coords" in w
    ? { location: { latLng: { latitude: w.coords.lat, longitude: w.coords.lon } } }
    : { address: w.address };
}

const MIN_AHEAD_MS = 60_000;

const parseSeconds = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const n = Number.parseFloat(v.replace(/s$/, ""));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

async function computeOnce(
  q: Pick<RouteQuery, "origin" | "destination" | "mode">,
  when: { departAtMs?: number; arriveAtMs?: number },
  now: number
): Promise<RouteResult> {
  const body: Record<string, unknown> = {
    origin: waypointBody(q.origin),
    destination: { address: q.destination },
    travelMode: GOOGLE_MODE[q.mode],
    languageCode: "es",
    units: "METRIC",
  };
  const region = process.env.MAPS_REGION_CODE?.trim();
  if (region) body.regionCode = region;

  let departAtMs: number | undefined;
  if (q.mode === "drive") {
    body.routingPreference = "TRAFFIC_AWARE"; // tráfico en vivo o previsto para esa hora
    if (when.departAtMs !== undefined && when.departAtMs > now + MIN_AHEAD_MS) {
      departAtMs = when.departAtMs;
      body.departureTime = new Date(departAtMs).toISOString();
    }
  } else if (q.mode === "transit") {
    if (when.arriveAtMs !== undefined && when.arriveAtMs > now + MIN_AHEAD_MS) {
      body.arrivalTime = new Date(when.arriveAtMs).toISOString();
    } else if (when.departAtMs !== undefined && when.departAtMs > now + MIN_AHEAD_MS) {
      departAtMs = when.departAtMs;
      body.departureTime = new Date(departAtMs).toISOString();
    }
  }

  const data = (await mapsPost(
    ROUTES_URL,
    "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description",
    body,
    "Ruta"
  )) as { routes?: { duration?: string; staticDuration?: string; distanceMeters?: number; description?: string }[] };

  const route = data.routes?.[0];
  const durationSec = parseSeconds(route?.duration);
  if (!route || durationSec === undefined) throw new MapsError("not_found", "No hay una ruta posible entre esos puntos.");
  return {
    durationSec,
    typicalSec: q.mode === "drive" ? parseSeconds(route.staticDuration) : undefined,
    distanceM: typeof route.distanceMeters === "number" ? route.distanceMeters : 0,
    via: cleanPlaceText(route.description) ?? undefined,
    departAtMs,
  };
}

/**
 * Distancia, tiempo y tráfico de una ruta. Con `arriveByMs` calcula también a qué hora salir:
 * en auto se estima la salida y se vuelve a consultar con esa hora para afinar el tráfico
 * (como máximo 2 consultas); en transporte público Google resuelve la llegada; a pie y en
 * bicicleta no hay tráfico y alcanza una consulta.
 */
export async function getRoute(q: RouteQuery): Promise<RouteResult> {
  const now = q.nowMs ?? Date.now();

  if (q.arriveByMs === undefined) {
    return computeOnce(q, { departAtMs: q.departAtMs }, now);
  }
  const arrive = q.arriveByMs;

  if (q.mode === "transit") {
    const r = await computeOnce(q, { arriveAtMs: arrive }, now);
    return { ...r, arriveByMs: arrive, leaveByMs: arrive - r.durationSec * 1000 };
  }
  if (q.mode !== "drive") {
    const r = await computeOnce(q, {}, now);
    return { ...r, arriveByMs: arrive, leaveByMs: arrive - r.durationSec * 1000 };
  }

  const guess = Math.max(now, arrive - 30 * 60_000);
  const first = await computeOnce(q, { departAtMs: guess }, now);
  let leaveBy = arrive - first.durationSec * 1000;
  // Si la estimación ya cayó cerca de la salida real, el tráfico previsto es casi el mismo.
  if (Math.abs(leaveBy - guess) <= 5 * 60_000) {
    return { ...first, arriveByMs: arrive, leaveByMs: leaveBy };
  }
  const second = await computeOnce(q, { departAtMs: Math.max(now, leaveBy) }, now);
  leaveBy = arrive - second.durationSec * 1000;
  return { ...second, arriveByMs: arrive, leaveByMs: leaveBy };
}

const toMin = (sec: number) => Math.max(1, Math.round(sec / 60));
const toKm = (m: number) => Math.round(m / 100) / 10;

/** Resultado compacto (pocos tokens) que se le devuelve al modelo. */
export function compactRoute(
  r: RouteResult,
  opts: {
    mode: TravelMode;
    from: string;
    to: string;
    nowMs?: number;
    /** UTC ms -> "YYYY-MM-DDTHH:mm:ss" en la zona del usuario. */
    local: (ms: number) => string;
    /** Quién calculó la ruta. Sin valor = Google Maps (comportamiento original). */
    provider?: MapsProviderName;
  }
) {
  const now = opts.nowMs ?? Date.now();
  const typical = r.typicalSec !== undefined ? toMin(r.typicalSec) : undefined;
  const minutes = toMin(r.durationSec);
  const delay = typical !== undefined && minutes > typical ? minutes - typical : 0;

  const out: Record<string, unknown> = {
    mode: MODE_LABEL[opts.mode],
    from: opts.from,
    to: opts.to,
    distance_km: toKm(r.distanceM),
    duration_min: minutes,
    ...(typical !== undefined ? { typical_duration_min: typical, traffic_delay_min: delay } : {}),
    ...(r.via ? { via: r.via } : {}),
    departure: r.departAtMs ? opts.local(r.departAtMs).slice(0, 16) : "ahora",
  };
  if (r.leaveByMs !== undefined && r.arriveByMs !== undefined) {
    out.arrive_by = opts.local(r.arriveByMs).slice(0, 16);
    out.leave_by = opts.local(r.leaveByMs).slice(0, 16);
    if (r.leaveByMs < now) {
      out.already_late = true;
      out.late_by_min = Math.ceil((now - r.leaveByMs) / 60_000);
    }
  }
  const provider = opts.provider ?? "google";
  out.source = provider === "osm" ? "OpenStreetMap" : "Google Maps";
  out.note =
    provider === "osm"
      ? "Estimaciones de OpenStreetMap SIN tráfico en vivo (tiempo con la vía libre): en auto suma un margen " +
        "razonable y dilo. Si el origen es la ubicación del usuario, es aproximada (~1 km). Las horas están en la zona del usuario."
      : "Estimaciones de Google Maps" +
        (opts.mode === "drive" ? " con el tráfico previsto" : "") +
        ". Si el origen es la ubicación del usuario, es aproximada (~1 km). Las horas están en la zona del usuario.";
  return out;
}

// --- Abrir la ruta en la app de Google Maps ------------------------------------------------

/** Acción para la app: abrir Google Maps con la ruta lista. No usa la API ni necesita clave. */
export interface MapsBody {
  kind: "maps_open";
  destination: string;
  /** Sin origen, Google Maps parte de la ubicación actual del teléfono. */
  origin?: string;
  mode: TravelMode;
  /**
   * Con qué app abrirla: "google" = Google Maps con la ruta completa (origen, destino y modo);
   * "any" = el selector de mapas de Android con el destino (Google Maps, OsmAnd, Organic Maps...).
   * Sin valor = "google" (comportamiento original).
   */
  open_with?: "google" | "any";
}

export function describeMaps(b: MapsBody): string {
  if (b.open_with === "any") {
    return `Abrir tu app de mapas con el destino "${b.destination}". Tú decides si inicias la navegación.`;
  }
  return (
    `Abrir Google Maps con la ruta ${MODE_LABEL[b.mode]} hasta "${b.destination}"` +
    (b.origin ? ` desde "${b.origin}"` : " desde tu ubicación") +
    ". Tú decides si inicias la navegación."
  );
}
