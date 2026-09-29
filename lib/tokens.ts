import { query } from "./db";
import { decrypt } from "./crypto";
import { refreshAccessToken } from "./google";
import { HttpError } from "./http";
import type { UserRow } from "./users";

/**
 * Cada request a Calendar pide un access_token nuevo con el refresh
 * token guardado. Es más simple que cachear expiración, y los access
 * tokens de Google duran ~1h así que el costo es aceptable para el
 * volumen de esta app.
 */
export async function getGoogleAccessTokenForUser(userId: string): Promise<string> {
  const rows = await query<Pick<UserRow, "google_refresh_token_enc">>(
    "SELECT google_refresh_token_enc FROM users WHERE id = ?",
    [userId]
  );
  const user = rows[0];
  if (!user) {
    throw new HttpError(404, "Usuario no encontrado");
  }
  const refreshToken = decrypt(user.google_refresh_token_enc);
  return refreshAccessToken(refreshToken);
}
