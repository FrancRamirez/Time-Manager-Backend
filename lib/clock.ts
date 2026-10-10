import { localToUtcMs, utcMsToLocal } from "./schedule";
import type { WhatsappBody } from "./whatsapp";
import type { SmsBody, CallBody } from "./phoneActions";
import type { MapsBody } from "./maps";
import type { DidiBody } from "./didi";
import { tr } from "./lang";

// ---------------------------------------------------------------------------
// Reloj del dispositivo (alarmas y temporizadores)
//
// Android solo deja CREAR alarmas/temporizadores y DESCARTAR alarmas mediante
// intents; no permite leer ni editar las existentes. Por eso:
//   - el servidor solo valida y propone (no puede tocar el reloj);
//   - la app ejecuta la acción en el dispositivo;
//   - la app guarda un registro local de las alarmas que creó el asistente y
//     lo manda en cada request de chat (el servidor no guarda nada).
// ---------------------------------------------------------------------------

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

const DAY_LABEL: Record<Day, string> = {
  mon: "lun",
  tue: "mar",
  wed: "mié",
  thu: "jue",
  fri: "vie",
  sat: "sáb",
  sun: "dom",
};

const DAY_LABEL_EN: Record<Day, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** Alarma creada por el asistente, según el registro que guarda la app. */
export interface DeviceAlarm {
  id: string;
  hour: number;
  minute: number;
  /** Vacío = alarma de una sola vez (la próxima vez que sea esa hora). */
  days: Day[];
  label?: string;
}

export type DeviceActionBody =
  | { kind: "alarm_set"; hour: number; minute: number; days: Day[]; label?: string }
  | { kind: "alarm_cancel"; alarmId: string; hour: number; minute: number; days: Day[]; label?: string }
  | {
      kind: "alarm_update";
      alarmId: string;
      old: { hour: number; minute: number; days: Day[]; label?: string };
      new: { hour: number; minute: number; days: Day[]; label?: string };
    }
  | { kind: "timer_set"; seconds: number; label?: string }
  | WhatsappBody
  | SmsBody
  | CallBody
  | MapsBody
  | DidiBody;

/** Acción que se manda a la app para ejecutarla en el dispositivo. */
export type DeviceAction = DeviceActionBody & {
  /** Texto armado por el servidor a partir de datos validados. */
  description: string;
  /** true: la app pide confirmación antes de ejecutar. false: la ejecuta de inmediato. */
  requiresConfirmation: boolean;
};

export const MAX_ALARMS = 50;
export const MAX_TIMER_SECONDS = 24 * 3600;
const MAX_LABEL = 60;

function cleanLabel(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_LABEL);
  return s || undefined;
}

function isDay(v: unknown): v is Day {
  return typeof v === "string" && (DAYS as readonly string[]).includes(v);
}

/** Acepta una lista de días; devuelve null si algún valor no es válido. */
export function parseDays(raw: unknown): Day[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: Day[] = [];
  for (const d of raw) {
    if (!isDay(d)) return null;
    if (!out.includes(d)) out.push(d);
  }
  return DAYS.filter((d) => out.includes(d)); // orden estable lun..dom
}

export function parseHourMinute(
  hour: unknown,
  minute: unknown
): { hour: number; minute: number } | null {
  const h = typeof hour === "number" ? hour : Number(hour);
  const m = typeof minute === "number" ? minute : Number(minute ?? 0);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hour: h, minute: m };
}

/** Valida el registro de alarmas que manda la app; nunca confía en el formato. */
export function parseAlarms(raw: unknown): DeviceAlarm[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceAlarm[] = [];
  for (const item of raw.slice(0, MAX_ALARMS)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || r.id.length > 64) continue;
    const hm = parseHourMinute(r.hour, r.minute);
    if (!hm) continue;
    const days = parseDays(r.days);
    if (!days) continue;
    out.push({ id: r.id, ...hm, days, label: cleanLabel(r.label) });
  }
  return out;
}

export function cleanAlarmLabel(v: unknown): string | undefined {
  return cleanLabel(v);
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

export function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Fecha local (YYYY-MM-DD) en que sonaría una alarma de una sola vez: Android
 * la programa para la PRÓXIMA vez que sea esa hora (hoy si aún no pasó, si no
 * mañana). No admite elegir otra fecha.
 */
export function nextOccurrenceDate(
  hour: number,
  minute: number,
  tz: string,
  nowMs: number = Date.now()
): string {
  const nowLocal = utcMsToLocal(nowMs, tz); // YYYY-MM-DDTHH:mm:ss
  const today = nowLocal.slice(0, 10);
  const todayAt = localToUtcMs(`${today}T${hhmm(hour, minute)}:00`, tz);
  if (todayAt > nowMs) return today;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 24 * 3600 * 1000);
  return tomorrow.toISOString().slice(0, 10);
}

/** Valida un "YYYY-MM-DD" y lo devuelve normalizado, o null. */
export function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1] ? null : m[1];
}

// ---------------------------------------------------------------------------
// Textos (los arma el servidor, no el modelo)
// ---------------------------------------------------------------------------

export function describeDays(days: Day[]): string {
  if (days.length === 0) return tr("una vez", "once");
  if (days.length === 7) return tr("todos los días", "every day");
  const key = days.join(",");
  if (key === "mon,tue,wed,thu,fri") return tr("de lunes a viernes", "Monday to Friday");
  if (key === "sat,sun") return tr("sábados y domingos", "weekends");
  return days.map((d) => tr(DAY_LABEL[d], DAY_LABEL_EN[d])).join(", ");
}

export function describeAlarm(a: {
  hour: number;
  minute: number;
  days: Day[];
  label?: string;
}): string {
  return `${hhmm(a.hour, a.minute)} (${describeDays(a.days)})${a.label ? ` "${a.label}"` : ""}`;
}

export function describeDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s) parts.push(`${s} s`);
  return parts.join(" ") || "0 s";
}
