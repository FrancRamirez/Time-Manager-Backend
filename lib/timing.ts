// ---------------------------------------------------------------------------
// Medición de tiempos (IDEA 4C: "medir primero")
//
// Cada request acumula cuánto tardó en cada paso (base de datos, token de Google, Calendar, Gmail,
// Gemini, FCM, pronóstico) y `route()` (lib/http.ts) escribe UNA línea JSON al terminar. Esas líneas
// se ven en los Logs de Vercel y se resumen con scripts/perf-summary.mjs. No se registra ningún dato
// del usuario: ni ids, ni correos, ni contenido (las rutas con ids se normalizan a ":id").
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";

export type Step =
  | "db"
  | "google_token"
  | "calendar"
  | "gmail"
  | "gemini"
  | "fcm"
  | "weather"
  | "http";

export interface StepTotals {
  n: number;
  ms: number;
}

export type TimingContext = Map<Step, StepTotals>;

const storage = new AsyncLocalStorage<TimingContext>();

/** Ejecuta `fn` con un contexto propio: lo medido dentro (aunque sea asíncrono) se acumula ahí. */
export function runWithTiming<T>(ctx: TimingContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function record(step: Step, ms: number) {
  const ctx = storage.getStore();
  if (!ctx) return;
  const cur = ctx.get(step) ?? { n: 0, ms: 0 };
  cur.n += 1;
  cur.ms += ms;
  ctx.set(step, cur);
}

/** Mide una operación asíncrona (se anota aunque falle). */
export async function timed<T>(step: Step, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    record(step, performance.now() - t0);
  }
}

/** A qué paso pertenece una URL externa. */
export function classifyUrl(raw: string): Step {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "http";
  }
  const { hostname: h, pathname: p } = u;
  if (h === "oauth2.googleapis.com" || (h === "www.googleapis.com" && p.startsWith("/oauth2/"))) {
    return "google_token";
  }
  if (h === "www.googleapis.com" && p.startsWith("/calendar/")) return "calendar";
  if (h === "gmail.googleapis.com" || (h === "www.googleapis.com" && p.startsWith("/gmail/"))) {
    return "gmail";
  }
  if (h === "generativelanguage.googleapis.com") return "gemini";
  if (h === "fcm.googleapis.com") return "fcm";
  if (h.endsWith(".open-meteo.com")) return "weather";
  return "http";
}

type UnauthorizedHandler = (bearerToken: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/**
 * tokens.ts registra aquí cómo olvidar un access token que Google rechazó (401), para que la
 * siguiente petición pida uno nuevo en vez de seguir usando el guardado en memoria.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
}

function bearerOf(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  const value =
    h instanceof Headers
      ? h.get("authorization")
      : Array.isArray(h)
        ? (h.find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? null)
        : ((h as Record<string, string>).Authorization ?? (h as Record<string, string>).authorization ?? null);
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

/**
 * fetch que mide el tiempo hasta recibir la respuesta (cabeceras; no incluye leer el cuerpo) y
 * anota el paso según la URL. Lee `globalThis.fetch` en cada llamada (así las pruebas pueden
 * sustituirlo). Si Google responde 401 a un token guardado en memoria, lo olvida.
 */
export async function tfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const step = classifyUrl(url);
  const t0 = performance.now();
  try {
    const res = await globalThis.fetch(input, init);
    if (res.status === 401 && (step === "calendar" || step === "gmail")) {
      const token = bearerOf(init);
      if (token) onUnauthorized?.(token);
    }
    return res;
  } finally {
    record(step, performance.now() - t0);
  }
}

// --- Registro por request -----------------------------------------------------------------

/** Ids opacos (uuid, ids de Calendar/Gmail) -> ":id", para que la ruta no identifique a nadie. */
export function normalizeRoute(rawUrl: string | undefined): string {
  const path = (rawUrl ?? "").split("?")[0] || "/";
  return path
    .split("/")
    .map((seg) => (/^[A-Za-z0-9_-]{16,}$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(seg) ? ":id" : seg))
    .join("/");
}

export function perfEnabled(): boolean {
  const v = process.env.PERF_LOG?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false");
}

/** Pasa de milisegundos con decimales a enteros (el log no necesita más precisión). */
const round = (n: number) => Math.round(n);

export function logPerf(opts: {
  method: string | undefined;
  url: string | undefined;
  status: number;
  ms: number;
  ctx: TimingContext;
}) {
  if (!perfEnabled()) return;
  const steps: Record<string, StepTotals> = {};
  for (const [name, t] of opts.ctx) steps[name] = { n: t.n, ms: round(t.ms) };
  const line = JSON.stringify({
    perf: 1,
    route: normalizeRoute(opts.url),
    method: opts.method ?? "?",
    status: opts.status,
    ms: round(opts.ms),
    steps,
  });
  // Una petición lenta sube de nivel para que sea fácil de encontrar en los logs.
  if (opts.ms > 5000) console.warn(line);
  else console.log(line);
}
