import { HttpError, env } from "./http";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  token_type: string;
}

/**
 * Verifica el idToken que manda la app (emitido por el SDK nativo de
 * Google Sign-In) contra el endpoint público de Google. Evita traer
 * una librería de verificación de JWT/JWKS completa para esto.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const res = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) {
    throw new HttpError(401, "idToken de Google inválido");
  }
  const payload = (await res.json()) as {
    sub: string;
    email: string;
    name: string;
    picture?: string;
    aud: string;
  };

  // El idToken debe haber sido emitido para alguno de nuestros client IDs
  // (el de Android o el Web, según cuál firmó la request).
  const validAudiences = [
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_ID,
  ].filter(Boolean);
  if (validAudiences.length && !validAudiences.includes(payload.aud)) {
    throw new HttpError(401, "idToken no corresponde a esta app");
  }

  return { sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
}

/**
 * Intercambia el serverAuthCode (de offlineAccess en el cliente) por un
 * refresh_token real de Google, con los scopes de Calendar/Gmail.
 */
export async function exchangeAuthCode(serverAuthCode: string): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: serverAuthCode,
      client_id: env("GOOGLE_WEB_CLIENT_ID"),
      client_secret: env("GOOGLE_WEB_CLIENT_SECRET"),
      // Con serverAuthCode de un cliente Android, redirect_uri debe ir vacío.
      redirect_uri: "",
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpError(401, `No se pudo intercambiar el código de Google: ${detail}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

/** Pide un access_token nuevo a partir del refresh_token guardado. */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env("GOOGLE_WEB_CLIENT_ID"),
      client_secret: env("GOOGLE_WEB_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new HttpError(401, "El refresh token de Google dejó de ser válido");
  }
  const data = (await res.json()) as GoogleTokenResponse;
  return data.access_token;
}

export interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  location?: string;
  status: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}

export async function listUpcomingEvents(accessToken: string, daysAhead: number) {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + daysAhead * 86_400_000).toISOString();

  const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "50");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new HttpError(502, "No se pudo consultar Google Calendar");
  }
  const data = (await res.json()) as { items?: GoogleCalendarEvent[] };
  return data.items ?? [];
}

export async function deleteCalendarEvent(accessToken: string, eventId: string) {
  const res = await fetch(`${CALENDAR_API}/calendars/primary/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 410) {
    throw new HttpError(502, "No se pudo cancelar el evento en Google Calendar");
  }
}
