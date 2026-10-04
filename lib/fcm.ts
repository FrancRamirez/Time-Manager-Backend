// ---------------------------------------------------------------------------
// Notificaciones push por Firebase Cloud Messaging (HTTP v1)
//
// FCM es gratuito. Se autentica con una cuenta de servicio de Firebase (variable
// FIREBASE_SERVICE_ACCOUNT: el JSON de la clave, tal cual o en base64). Se envían mensajes SOLO de
// datos: la app los recibe con la app cerrada y arma ella misma la notificación con sus botones
// ("Aceptar cambio" / "Ignorar"). Nunca se registran tokens ni claves en los logs.
// ---------------------------------------------------------------------------

import { SignJWT, importPKCS8 } from "jose";
import { tfetch } from "./timing";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TIMEOUT_MS = 8_000;

/** Lee y valida la cuenta de servicio. null = no configurada (el barrido analiza pero no envía). */
export function readServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const sa = JSON.parse(text) as Partial<ServiceAccount>;
    if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error("faltan campos");
    // Al pegar el JSON en una variable de entorno los saltos de línea suelen quedar como "\n" literal.
    return { ...(sa as ServiceAccount), private_key: sa.private_key.replace(/\\n/g, "\n") };
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT no es un JSON de cuenta de servicio válido");
  }
}

let cached: { token: string; expiresAt: number } | null = null;

/** Token OAuth de la cuenta de servicio; se reutiliza mientras no venza. */
async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const res = await tfetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FCM: no se pudo obtener el token de acceso (HTTP ${res.status})`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("FCM: respuesta sin access_token");
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export type PushOutcome = "sent" | "unregistered" | "failed";

/**
 * Envía un mensaje de datos a un token. "unregistered" = el token ya no existe (app desinstalada o
 * token renovado): quien llama debe borrarlo. Cualquier otro fallo es "failed" y no borra nada.
 */
export async function sendPush(
  sa: ServiceAccount,
  fcmToken: string,
  data: Record<string, string>
): Promise<PushOutcome> {
  try {
    const accessToken = await getAccessToken(sa);
    const res = await tfetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          data,
          // Prioridad alta: despierta la app para armar la notificación aunque esté cerrada.
          android: { priority: "HIGH", ttl: "3600s" },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return "sent";

    const body = (await res.json().catch(() => null)) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    } | null;
    const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode;
    if (res.status === 404 || code === "UNREGISTERED" || body?.error?.status === "NOT_FOUND") {
      return "unregistered";
    }
    console.error(`FCM: envío rechazado (HTTP ${res.status}${code ? `, ${code}` : ""})`);
    return "failed";
  } catch (err) {
    console.error("FCM: error al enviar:", (err as Error).message);
    return "failed";
  }
}
