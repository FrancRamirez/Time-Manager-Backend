// ---------------------------------------------------------------------------
// Acceso y cobro de la app (preparado, APAGADO por defecto)
// ---------------------------------------------------------------------------
//
// Todo lo que decide "¿este usuario tiene que pagar?" vive acá, en el SERVIDOR (la app solo muestra lo que el
// servidor indica; un cliente modificado no puede saltarse el cobro).
//
//   BILLING_ENABLED     = true para empezar a cobrar. Apagada (o ausente): NADIE ve el mensaje de pagar.
//   FREE_ACCESS_EMAILS  = correos que usan la app sin pagar. "ana@x.com" = gratis siempre;
//                         "ana@x.com:2026-12-31" = de prueba hasta esa fecha (inclusive). Se separan con coma.
//   users.access_override / users.access_until (base de datos) = lo mismo por usuario, sin redesplegar:
//                         UPDATE users SET access_override='free' WHERE email='ana@x.com';
//                         UPDATE users SET access_override='trial', access_until='2026-12-31' WHERE email='...';
//
// Orden de decisión: cobro apagado -> lista de correos -> acceso por usuario -> compra verificada -> debe pagar.

import type { VercelRequest } from "@vercel/node";
import { HttpError } from "./http";
import { requireUser } from "./auth";
import { query } from "./db";
import { tr } from "./lang";

export type Access = "open" | "free" | "trial" | "paid" | "payment_required";

export interface AccessInfo {
  access: Access;
  /** true = hay que mostrar la pantalla de pago y bloquear la IA. */
  paywall: boolean;
  /** Hasta cuándo vale el acceso (prueba o suscripción), en ISO UTC. null = sin vencimiento. */
  until: string | null;
}

/** Campos de `users` que importan (todos opcionales: una base sin migrar sigue funcionando). */
export interface AccessRow {
  email?: string | null;
  onboarding_completed?: number | boolean | null;
  subscription_active?: number | boolean | null;
  access_override?: string | null;
  access_until?: string | Date | null;
  subscription_expires_at?: string | Date | null;
}

export function billingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.BILLING_ENABLED ?? "").trim());
}

interface FreeEntry {
  email: string;
  /** ms UTC hasta los que vale; null = sin vencimiento. */
  until: number | null;
}

/** Interpreta FREE_ACCESS_EMAILS. Una fecha mal escrita descarta ESA entrada (no la deja gratis para siempre). */
export function parseFreeAccess(raw: string | undefined = process.env.FREE_ACCESS_EMAILS): FreeEntry[] {
  const out: FreeEntry[] = [];
  for (const item of (raw ?? "").split(/[,;\n]/)) {
    const t = item.trim();
    if (!t) continue;
    const [emailPart, datePart] = t.split(":").map((s) => s.trim());
    const email = emailPart.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (datePart === undefined || datePart === "") {
      out.push({ email, until: null });
      continue;
    }
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? Date.parse(`${datePart}T23:59:59.999Z`) : NaN;
    if (Number.isNaN(ms)) {
      console.warn(`FREE_ACCESS_EMAILS: fecha inválida para ${email} ("${datePart}"); se ignora esa entrada.`);
      continue;
    }
    out.push({ email, until: ms });
  }
  return out;
}

/** Fecha de la base de datos (Date o texto "YYYY-MM-DD[ HH:MM:SS]", siempre UTC) -> ms. */
function toMs(v: string | Date | null | undefined, endOfDay = false): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const s = String(v).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const ms = Date.parse(dateOnly ? `${s}T${endOfDay ? "23:59:59.999" : "00:00:00"}Z` : `${s.replace(" ", "T")}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? "" : "Z"}`);
  return Number.isNaN(ms) ? null : ms;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Lógica pura (sin red ni base de datos): ¿qué acceso tiene este usuario ahora? */
export function computeAccess(row: AccessRow, now = Date.now()): AccessInfo {
  if (!billingEnabled()) return { access: "open", paywall: false, until: null };

  const email = (row.email ?? "").trim().toLowerCase();
  if (email) {
    for (const entry of parseFreeAccess()) {
      if (entry.email !== email) continue;
      if (entry.until === null) return { access: "free", paywall: false, until: null };
      if (entry.until > now) return { access: "trial", paywall: false, until: iso(entry.until) };
    }
  }

  if (row.access_override === "free") return { access: "free", paywall: false, until: null };
  if (row.access_override === "trial") {
    const until = toMs(row.access_until, true);
    if (until !== null && until > now) return { access: "trial", paywall: false, until: iso(until) };
  }

  const paidOnce = Boolean(Number(row.onboarding_completed ?? 0));
  const subscribed = Boolean(Number(row.subscription_active ?? 0));
  if (paidOnce && subscribed) {
    const expires = toMs(row.subscription_expires_at);
    if (expires === null || expires > now) return { access: "paid", paywall: false, until: expires === null ? null : iso(expires) };
  }

  return { access: "payment_required", paywall: true, until: null };
}

/**
 * Como requireUser, pero además corta (402) a quien debe pagar. Con el cobro apagado NO consulta la base de datos
 * (cero costo y cero riesgo). Úsalo en todo lo que gasta IA o recursos del servidor.
 */
export async function requireAccess(req: VercelRequest): Promise<string> {
  const userId = await requireUser(req);
  if (!billingEnabled()) return userId;

  const rows = await query<AccessRow>("SELECT * FROM users WHERE id = ?", [userId]);
  if (!rows[0]) throw new HttpError(401, tr("Sesión no válida", "Invalid session"), { code: "session_expired" });
  if (computeAccess(rows[0]).paywall) {
    throw new HttpError(402, tr("Para seguir usando el asistente, activa tu cuenta.", "To keep using the assistant, activate your account."), { code: "payment_required" });
  }
  return userId;
}

/** De una lista de usuarios, los que pueden usar el servicio (para el barrido con la app cerrada). */
export async function entitledUserIds(ids: string[]): Promise<Set<string>> {
  if (!billingEnabled() || !ids.length) return new Set(ids);
  const rows = await query<AccessRow & { id: string }>(
    `SELECT * FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
  return new Set(rows.filter((r) => !computeAccess(r).paywall).map((r) => r.id));
}
