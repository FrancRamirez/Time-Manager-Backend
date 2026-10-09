// ---------------------------------------------------------------------------
// Verificación de compras con la Google Play Developer API (SIN probar contra Google Play real)
// ---------------------------------------------------------------------------
//
// La app nunca decide si un pago es válido: manda el "purchase token" y ESTE módulo lo verifica con Google
// (cuenta de servicio con permiso de Finanzas en Play Console). También confirma ("acknowledge") la compra:
// si no se confirma en 3 días, Google la reembolsa sola.
//
// Variables: PLAY_PACKAGE_NAME, PLAY_ONBOARDING_PRODUCT_ID (pago único), PLAY_SUBSCRIPTION_ID (suscripción mensual),
// PLAY_SERVICE_ACCOUNT_JSON (JSON de la cuenta de servicio, tal cual o en base64).

import { SignJWT, importPKCS8 } from "jose";
import { tfetch } from "./timing";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TIMEOUT_MS = 8_000;

export type Verified<T> = ({ ok: true } & T) | { ok: false; reason: string };

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function playConfig(): { packageName: string; onboardingProductId: string; subscriptionId: string; account: ServiceAccount } | null {
  const packageName = process.env.PLAY_PACKAGE_NAME?.trim();
  const onboardingProductId = process.env.PLAY_ONBOARDING_PRODUCT_ID?.trim();
  const subscriptionId = process.env.PLAY_SUBSCRIPTION_ID?.trim();
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!packageName || !onboardingProductId || !subscriptionId || !raw) return null;
  try {
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const account = JSON.parse(text) as ServiceAccount;
    if (!account.client_email || !account.private_key) return null;
    return { packageName, onboardingProductId, subscriptionId, account };
  } catch {
    return null;
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export function clearPlayTokenCache() {
  cachedToken = null;
}

async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const key = await importPKCS8(account.private_key.replace(/\\n/g, "\n"), "RS256");
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience(tokenUri)
    .setIssuedAt()
    .setExpirationTime("55m")
    .sign(key);
  const res = await tfetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token de Google Play: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("token de Google Play: respuesta inesperada");
  cachedToken = { value: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

/** Un token de compra real es una cadena larga sin espacios; se rechaza todo lo demás antes de armar la URL. */
export function validPurchaseToken(t: unknown): t is string {
  return typeof t === "string" && t.length >= 10 && t.length <= 2000 && /^[A-Za-z0-9._\-]+$/.test(t);
}

async function playFetch(cfg: NonNullable<ReturnType<typeof playConfig>>, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(cfg.account);
  return tfetch(`${API}/${encodeURIComponent(cfg.packageName)}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Pago único de activación. Solo vale el producto configurado (el cliente no elige cuál). */
export async function verifyOnboardingPurchase(purchaseToken: string): Promise<Verified<{ orderId: string | null }>> {
  const cfg = playConfig();
  if (!cfg) return { ok: false, reason: "El cobro todavía no está configurado en el servidor." };
  if (!validPurchaseToken(purchaseToken)) return { ok: false, reason: "Compra no válida." };
  try {
    const path = `purchases/products/${encodeURIComponent(cfg.onboardingProductId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    const res = await playFetch(cfg, path);
    if (!res.ok) return { ok: false, reason: "Google Play no reconoce esa compra." };
    const p = (await res.json()) as { purchaseState?: number; acknowledgementState?: number; orderId?: string; consumptionState?: number };
    if (p.purchaseState !== 0) return { ok: false, reason: p.purchaseState === 2 ? "El pago todavía está pendiente." : "La compra fue cancelada." };
    if (p.acknowledgementState === 0) {
      const ack = await playFetch(cfg, `${path}:acknowledge`, { method: "POST", body: "{}" });
      if (!ack.ok) console.error("Play: no se pudo confirmar la compra (acknowledge): HTTP", ack.status);
    }
    return { ok: true, orderId: p.orderId ?? null };
  } catch (err) {
    console.error("Verificación de compra falló:", (err as Error).message);
    return { ok: false, reason: "No se pudo verificar el pago ahora. Intenta de nuevo en un momento." };
  }
}

/** Suscripción mensual. Vale mientras esté activa, en período de gracia o cancelada pero con tiempo pagado. */
export async function verifySubscription(purchaseToken: string): Promise<Verified<{ expiresAtMs: number }>> {
  const cfg = playConfig();
  if (!cfg) return { ok: false, reason: "El cobro todavía no está configurado en el servidor." };
  if (!validPurchaseToken(purchaseToken)) return { ok: false, reason: "Suscripción no válida." };
  try {
    const res = await playFetch(cfg, `purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
    if (!res.ok) return { ok: false, reason: "Google Play no reconoce esa suscripción." };
    const s = (await res.json()) as {
      subscriptionState?: string;
      acknowledgementState?: string;
      lineItems?: { productId?: string; expiryTime?: string }[];
    };
    const items = (s.lineItems ?? []).filter((li) => li.productId === cfg.subscriptionId);
    if (!items.length) return { ok: false, reason: "Esa suscripción no es la de Time Manager." };
    const expiresAtMs = Math.max(...items.map((li) => Date.parse(li.expiryTime ?? "")).filter((n) => Number.isFinite(n)), 0);
    const live = ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_CANCELED"].includes(s.subscriptionState ?? "");
    if (!live || expiresAtMs <= Date.now()) return { ok: false, reason: "La suscripción no está activa." };
    if (s.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
      const ack = await playFetch(
        cfg,
        `purchases/subscriptions/${encodeURIComponent(cfg.subscriptionId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
        { method: "POST", body: "{}" }
      );
      if (!ack.ok) console.error("Play: no se pudo confirmar la suscripción (acknowledge): HTTP", ack.status);
    }
    return { ok: true, expiresAtMs };
  } catch (err) {
    console.error("Verificación de suscripción falló:", (err as Error).message);
    return { ok: false, reason: "No se pudo verificar la suscripción ahora. Intenta de nuevo en un momento." };
  }
}
