import { HttpError, env } from "./http";
import { tfetch } from "./timing";

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
  const res = await tfetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
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
    throw new HttpError(
      401,
      `idToken no corresponde a esta app | aud=${payload.aud} | esperados=${validAudiences.join(", ")}`
    );
  }

  return { sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
}

/**
 * Intercambia el serverAuthCode (de offlineAccess en el cliente) por un
 * refresh_token real de Google, con los scopes de Calendar/Gmail.
 */
export async function exchangeAuthCode(serverAuthCode: string): Promise<GoogleTokenResponse> {
  const res = await tfetch(GOOGLE_TOKEN_URL, {
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
  return (await refreshAccessTokenWithExpiry(refreshToken)).accessToken;
}

/** Igual que refreshAccessToken, pero también devuelve cuántos segundos dura el token (para guardarlo). */
export async function refreshAccessTokenWithExpiry(
  refreshToken: string
): Promise<{ accessToken: string; expiresInSec: number }> {
  const res = await tfetch(GOOGLE_TOKEN_URL, {
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
    const detail = await res.text().catch(() => "");
    let googleError: unknown;
    try {
      googleError = (JSON.parse(detail) as { error?: unknown }).error;
    } catch {
      /* el cuerpo no era JSON */
    }
    // invalid_grant = el refresh token caducó (7 días en modo Testing) o el usuario revocó el acceso.
    // Solo ese caso obliga a volver a iniciar sesión; cualquier otro fallo de Google es transitorio o
    // de configuración y NO debe cerrar la sesión del usuario.
    if (googleError === "invalid_grant") {
      throw new HttpError(401, "Tu conexión con Google venció. Vuelve a iniciar sesión.", {
        code: "google_reauth",
      });
    }
    console.error("Google refresh falló:", res.status, detail);
    throw new HttpError(502, "No se pudo renovar el acceso a Google");
  }
  const data = (await res.json()) as GoogleTokenResponse;
  return { accessToken: data.access_token, expiresInSec: Number(data.expires_in) || 3600 };
}

/**
 * Campos que el código usa de cada evento (ver GoogleCalendarEvent). Con `fields` Google no manda
 * descripciones, invitados completos, datos de videollamada, etc.: la respuesta pesa mucho menos.
 * Si se empieza a leer otra propiedad de un evento, hay que agregarla aquí (hay una prueba que lo vigila).
 */
export const LIST_FIELDS = "items(id,summary,location,status,start(dateTime,date),end(dateTime,date))";

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
  url.searchParams.set("fields", LIST_FIELDS);

  const res = await tfetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Calendar list falló:", res.status, detail);
    throw new HttpError(502, "No se pudo consultar Google Calendar");
  }
  const data = (await res.json()) as { items?: GoogleCalendarEvent[] };
  return data.items ?? [];
}

export async function deleteCalendarEvent(accessToken: string, eventId: string) {
  const res = await calendarCall(
    "delete",
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok && res.status !== 410) {
    const detail = await res.text().catch(() => "");
    console.error("Calendar delete falló", res.status, detail);
    throw calendarError("delete", res.status, detail);
  }
}

export interface CalendarEventInput {
  title?: string;
  /** Hora local sin offset, formato "YYYY-MM-DDTHH:mm:ss" */
  start?: string;
  end?: string;
  timeZone: string;
  location?: string;
  description?: string;
}

function toGoogleEventBody(input: CalendarEventInput) {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.summary = input.title;
  if (input.location !== undefined) body.location = input.location;
  if (input.description !== undefined) body.description = input.description;
  if (input.start) body.start = { dateTime: input.start, timeZone: input.timeZone };
  if (input.end) body.end = { dateTime: input.end, timeZone: input.timeZone };
  return body;
}

export async function getCalendarEvent(
  accessToken: string,
  eventId: string
): Promise<GoogleCalendarEvent | null> {
  const res = await tfetch(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) {
    throw new HttpError(502, "No se pudo consultar el evento en Google Calendar");
  }
  const event = (await res.json()) as GoogleCalendarEvent;
  return event.status === "cancelled" ? null : event;
}

// ---------------------------------------------------------------------------
// Errores de Calendar: causa real para el log, mensaje claro para el usuario
// ---------------------------------------------------------------------------

/**
 * Traduce la respuesta de error de Google Calendar a un HttpError que la app puede explicar.
 * `retryable: true` = es pasajero: la acción propuesta sigue vigente y se puede reintentar.
 * Los textos son para el usuario casual; el detalle técnico queda solo en el log.
 */
function calendarError(op: string, status: number, detail: string): HttpError {
  const fail = (httpStatus: number, message: string, code: string, retryable: boolean) =>
    new HttpError(httpStatus, message, { code, retryable });

  if (status === 401) {
    return fail(
      502,
      "Google rechazó el acceso a tu calendario por un momento. Prueba de nuevo; si sigue pasando, cierra sesión en la app y vuelve a entrar.",
      "calendar_auth",
      true
    );
  }
  if (status === 403) {
    if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(detail)) {
      return fail(
        403,
        "Frami no tiene permiso para modificar tu calendario. Cierra sesión en la app y vuelve a entrar aceptando todos los permisos de Google Calendar.",
        "calendar_permission",
        false
      );
    }
    if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(detail)) {
      return fail(
        502,
        "El servicio de Google Calendar no está activado para esta app. No depende de ti: avisa al soporte.",
        "calendar_config",
        false
      );
    }
    if (/rateLimit|quotaExceeded/i.test(detail)) {
      return fail(
        503,
        "Google Calendar está recibiendo demasiados pedidos. Espera unos segundos y vuelve a intentar.",
        "calendar_unavailable",
        true
      );
    }
    return fail(
      403,
      "Google no permitió modificar ese calendario o evento. Revisa que tengas permiso de edición sobre él.",
      "calendar_forbidden",
      false
    );
  }
  if (status === 400) {
    return fail(
      502,
      "Google no aceptó los datos del evento (por ejemplo la fecha u hora). Pídeme el evento de nuevo indicando día y hora con claridad.",
      "calendar_bad_request",
      false
    );
  }
  if (status === 404 || status === 410) {
    return fail(404, "Ese evento ya no existe en tu calendario.", "calendar_not_found", false);
  }
  // 429, 5xx u otro: del lado de Google, pasajero.
  console.error(`Calendar ${op} falló con estado inesperado`, status);
  return fail(
    503,
    "Google Calendar no respondió bien en este momento. No es un problema de tu cuenta. Prueba de nuevo en un momento.",
    "calendar_unavailable",
    true
  );
}

/** Llama a Calendar; una caída de red o un corte por tiempo también se informan como "pasajero". */
async function calendarCall(op: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await tfetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    console.error(`Calendar ${op} sin respuesta:`, (err as Error).message);
    throw new HttpError(
      503,
      "No pude conectarme con Google Calendar. Prueba de nuevo en un momento.",
      { code: "calendar_unavailable", retryable: true }
    );
  }
  return res;
}

export async function createCalendarEvent(
  accessToken: string,
  input: CalendarEventInput
): Promise<GoogleCalendarEvent> {
  const res = await calendarCall("create", `${CALENDAR_API}/calendars/primary/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(toGoogleEventBody(input)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Calendar create falló", res.status, detail);
    throw calendarError("create", res.status, detail);
  }
  return (await res.json()) as GoogleCalendarEvent;
}

export async function patchCalendarEvent(
  accessToken: string,
  eventId: string,
  input: CalendarEventInput
): Promise<GoogleCalendarEvent> {
  const res = await calendarCall(
    "patch",
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(toGoogleEventBody(input)),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Calendar patch falló", res.status, detail);
    throw calendarError("patch", res.status, detail);
  }
  return (await res.json()) as GoogleCalendarEvent;
}
