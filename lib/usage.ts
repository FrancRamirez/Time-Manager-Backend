import { exec, query } from "./db";
import { localToUtcMs, utcMsToLocal } from "./schedule";

/**
 * Cupo diario de mensajes de IA por usuario.
 *
 * Gemini no expone cuánta cuota queda, así que se lleva la cuenta acá. Google
 * reinicia sus cuotas diarias (RPD) a medianoche hora del Pacífico, por eso el
 * "día" del contador y el momento de renovación usan esa misma zona.
 *
 * AI_DAILY_MESSAGES_PER_USER: mensajes por usuario y día (0 = sin límite propio).
 * Ojo: la cuota gratuita de Google es POR PROYECTO (la comparten todos los usuarios)
 * y se cuenta en requests, no en mensajes; un mensaje puede gastar de 1 a 4.
 */
const RESET_TZ = "America/Los_Angeles";
const DEFAULT_LIMIT = 10;

export interface UsageSnapshot {
  used: number;
  /** 0 = sin límite propio. */
  limit: number;
  remaining: number;
  /** Segundos hasta que el contador vuelve a cero. */
  resetsInSeconds: number;
  /** Instante exacto de la renovación (ISO UTC). */
  resetsAt: string;
}

export function dailyLimit(): number {
  const raw = process.env.AI_DAILY_MESSAGES_PER_USER;
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
}

/** Día actual en hora del Pacífico, "YYYY-MM-DD". */
function pacificDay(now: number): string {
  return utcMsToLocal(now, RESET_TZ).slice(0, 10);
}

/** Próxima medianoche del Pacífico, en ms UTC. */
export function nextResetMs(now = Date.now()): number {
  const day = pacificDay(now);
  const tomorrow = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return localToUtcMs(`${tomorrow}T00:00:00`, RESET_TZ);
}

export function snapshot(used: number, now = Date.now()): UsageSnapshot {
  const limit = dailyLimit();
  const reset = nextResetMs(now);
  return {
    used,
    limit,
    remaining: limit > 0 ? Math.max(0, limit - used) : Number.MAX_SAFE_INTEGER,
    resetsInSeconds: Math.max(1, Math.ceil((reset - now) / 1000)),
    resetsAt: new Date(reset).toISOString(),
  };
}

export async function messagesUsedToday(userId: string): Promise<number> {
  const rows = await query<{ messages: number | string }>(
    "SELECT messages FROM ai_usage WHERE user_id = ? AND usage_date = ?",
    [userId, pacificDay(Date.now())]
  );
  return Number(rows[0]?.messages ?? 0);
}

/** Suma un mensaje al contador de hoy y devuelve el total. */
export async function recordMessage(userId: string): Promise<number> {
  await exec(
    `INSERT INTO ai_usage (user_id, usage_date, messages) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE messages = messages + 1`,
    [userId, pacificDay(Date.now())]
  );
  return messagesUsedToday(userId);
}
