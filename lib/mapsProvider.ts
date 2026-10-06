// ---------------------------------------------------------------------------
// Elige quién resuelve las consultas de mapas: Google Maps u OpenStreetMap (gratis)
// ---------------------------------------------------------------------------
//
// MAPS_PROVIDER:
//   "auto"   (por defecto) Google Maps si hay GOOGLE_MAPS_API_KEY; si Google falla (cuota, clave, red,
//            error) o no encuentra nada, se intenta con OpenStreetMap. Sin clave, solo OpenStreetMap.
//   "google" solo Google Maps (comportamiento original: sin clave, no hay búsquedas ni tiempos).
//   "osm"    solo OpenStreetMap (gratis, sin clave, sin tráfico ni transporte público).
//
// Abrir la ruta en el teléfono (open_maps_route) no pasa por acá: no usa ninguna API.

import { getRoute, mapsConfigured, searchPlaces, MapsError, type FoundPlace, type MapsProviderName, type RouteQuery, type RouteResult } from "./maps";
import { getRouteOsm, searchPlacesOsm } from "./osm";
import type { Coords } from "./weather";

export type MapsProviderMode = "auto" | "google" | "osm";

export function providerMode(): MapsProviderMode {
  const raw = process.env.MAPS_PROVIDER?.trim().toLowerCase();
  return raw === "google" || raw === "osm" ? raw : "auto";
}

/** Proveedores a probar, en orden. */
function chain(): MapsProviderName[] {
  const mode = providerMode();
  if (mode === "osm") return ["osm"];
  if (mode === "google") return ["google"];
  return mapsConfigured() ? ["google", "osm"] : ["osm"];
}

/** Hay al menos un proveedor usable (con "google" sin clave no). */
export function mapsAvailable(): boolean {
  return providerMode() !== "google" || mapsConfigured();
}

/** Qué app abre open_maps_route: Google Maps, salvo que el servidor use solo OpenStreetMap. */
export function openWith(): "google" | "any" {
  return providerMode() === "osm" ? "any" : "google";
}

/** Un fallo de "no se pudo ubicar" no se reintenta con otro proveedor: el usuario debe precisar. */
const retryable = (e: unknown) => !(e instanceof MapsError && e.kind === "not_found");

export async function findPlaces(query: string, near?: Coords): Promise<{ places: FoundPlace[]; provider: MapsProviderName }> {
  const order = chain();
  let lastErr: unknown;
  let empty: MapsProviderName | undefined;
  for (const provider of order) {
    try {
      const places = provider === "google" ? await searchPlaces(query, near) : await searchPlacesOsm(query, near);
      if (places.length) return { places, provider };
      empty = provider; // sin resultados: se prueba con el siguiente
    } catch (err) {
      lastErr = err;
      if (!retryable(err)) break;
    }
  }
  if (empty) return { places: [], provider: empty };
  throw lastErr;
}

export async function routeBetween(q: RouteQuery): Promise<{ route: RouteResult; provider: MapsProviderName }> {
  const order = chain();
  let firstErr: unknown;
  for (const provider of order) {
    try {
      const route = provider === "google" ? await getRoute(q) : await getRouteOsm(q);
      return { route, provider };
    } catch (err) {
      // Se conserva el error del primer proveedor: es el que mejor explica qué pasó.
      firstErr ??= err;
      if (!retryable(err)) break;
    }
  }
  throw firstErr;
}
