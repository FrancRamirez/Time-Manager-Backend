import { query } from "./db";
import { decrypt } from "./crypto";
import { refreshAccessTokenWithExpiry } from "./google";
import { HttpError } from "./http";
import { setUnauthorizedHandler } from "./timing";
import type { UserRow } from "./users";

/**
 * Access token de Google por usuario, guardado EN MEMORIA de la instancia (nunca en la base ni en
 * logs). Mientras la instancia siga "caliente" se reutiliza en vez de leer el refresh token, descifrarlo
 * y pedirle uno nuevo a Google en cada request (~1 viaje a la base + 1 a Google). Un access token de
 * Google dura ~1 h; se guarda con margen y como máximo 50 min.
 *
 * - Peticiones simultáneas del mismo usuario comparten UNA sola renovación.
 * - Un fallo (por ejemplo el acceso revocado) no se guarda: se vuelve a intentar y se informa.
 * - Si Calendar o Gmail responden 401 a un token guardado, se olvida para pedir uno nuevo (si el
 *   usuario revocó el acceso, la renovación falla con google_reauth y la app pide iniciar sesión).
 */
const SAFETY_MS = 5 * 60_000;
const MAX_TTL_MS = 50 * 60_000;
const MAX_ENTRIES = 500;

const cache = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();

function remember(userId: string, token: string, expiresInSec: number) {
  const ttl = Math.min(MAX_TTL_MS, expiresInSec * 1000 - SAFETY_MS);
  if (ttl <= 0) return; // token que vence enseguida: no vale la pena guardarlo
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [id, e] of cache) if (e.expiresAt <= now) cache.delete(id);
    // Si sigue lleno, se descarta el más antiguo (los Map conservan el orden de inserción).
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  }
  cache.delete(userId);
  cache.set(userId, { token, expiresAt: Date.now() + ttl });
}

/** Olvida el token que Google rechazó (la siguiente petición pedirá uno nuevo). */
export function invalidateGoogleAccessToken(token: string) {
  for (const [userId, e] of cache) if (e.token === token) cache.delete(userId);
}
setUnauthorizedHandler(invalidateGoogleAccessToken);

/** Solo para pruebas. */
export function clearGoogleTokenCache() {
  cache.clear();
  inflight.clear();
}

export async function getGoogleAccessTokenForUser(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const pending = inflight.get(userId);
  if (pending) return pending;

  const request = (async () => {
    const rows = await query<Pick<UserRow, "google_refresh_token_enc">>(
      "SELECT google_refresh_token_enc FROM users WHERE id = ?",
      [userId]
    );
    const user = rows[0];
    if (!user) {
      throw new HttpError(404, "Usuario no encontrado");
    }
    const { accessToken, expiresInSec } = await refreshAccessTokenWithExpiry(
      decrypt(user.google_refresh_token_enc)
    );
    remember(userId, accessToken, expiresInSec);
    return accessToken;
  })().finally(() => inflight.delete(userId));

  inflight.set(userId, request);
  return request;
}
