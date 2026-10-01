import { HttpError } from "./http";
import type { GoogleCalendarEvent } from "./google";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// Preferencias del usuario (las manda la app en cada request de chat)
// ---------------------------------------------------------------------------

export interface BlockedRange {
  /** 0 = domingo ... 6 = sábado (igual que la app) */
  dayOfWeek: number;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm" (si es menor o igual que startTime, cruza la medianoche)
  label?: string;
}

export interface AssistantSettings {
  autonomyLevel: "suggestion" | "autopilot";
  bufferMinutes: number;
  dailyActionLimit: number;
  blockedHours: BlockedRange[];
}

export const DEFAULT_SETTINGS: AssistantSettings = {
  autonomyLevel: "suggestion",
  bufferMinutes: 0,
  dailyActionLimit: 100,
  blockedHours: [],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Valida y sanea lo que llega del cliente; nunca confía en el formato. */
export function parseSettings(raw: unknown): AssistantSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const r = raw as Record<string, unknown>;

  const blockedHours: BlockedRange[] = [];
  if (Array.isArray(r.blockedHours)) {
    for (const item of r.blockedHours.slice(0, 50)) {
      if (typeof item !== "object" || item === null) continue;
      const b = item as Record<string, unknown>;
      const day = Number(b.dayOfWeek);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      if (typeof b.startTime !== "string" || !HHMM.test(b.startTime)) continue;
      if (typeof b.endTime !== "string" || !HHMM.test(b.endTime)) continue;
      if (b.startTime === b.endTime) continue;
      blockedHours.push({
        dayOfWeek: day,
        startTime: b.startTime,
        endTime: b.endTime,
        label:
          typeof b.label === "string"
            ? b.label.replace(/[\r\n]+/g, " ").trim().slice(0, 40) || undefined
            : undefined,
      });
    }
  }

  return {
    autonomyLevel: r.autonomyLevel === "autopilot" ? "autopilot" : "suggestion",
    bufferMinutes: clampInt(r.bufferMinutes, 0, 240, 0),
    dailyActionLimit: clampInt(r.dailyActionLimit, 1, 500, 100),
    blockedHours,
  };
}

const DAY_NAMES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

export function describeBlockedHours(ranges: BlockedRange[]): string {
  if (!ranges.length) return "ninguna";
  return ranges
    .map(
      (b) =>
        `${DAY_NAMES[b.dayOfWeek]} ${b.startTime}-${b.endTime}` + (b.label ? ` (${b.label})` : "")
    )
    .join("; ");
}

// ---------------------------------------------------------------------------
// Zonas horarias: hora "local naive" (YYYY-MM-DDTHH:mm:ss) <-> instante UTC
// ---------------------------------------------------------------------------

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-10-01T15:45:00" interpretado en la zona tz -> milisegundos UTC. */
export function localToUtcMs(naive: string, tz: string): number {
  const guess = Date.parse(naive + "Z");
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz); // segunda pasada: cambios de horario (DST)
  return utc;
}

/** Milisegundos UTC -> "YYYY-MM-DDTHH:mm:ss" en la zona tz. */
export function utcMsToLocal(ms: number, tz: string): string {
  return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 19);
}

// ---------------------------------------------------------------------------
// Consulta de Calendar por ventana de tiempo
// ---------------------------------------------------------------------------

type CalEvent = GoogleCalendarEvent & { transparency?: string };

async function listEventsBetween(
  accessToken: string,
  fromMs: number,
  toMs: number
): Promise<CalEvent[]> {
  const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
  url.searchParams.set("timeMin", new Date(fromMs).toISOString());
  url.searchParams.set("timeMax", new Date(toMs).toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "100");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    console.error("Calendar window falló:", res.status, await res.text().catch(() => ""));
    throw new HttpError(502, "No se pudo consultar Google Calendar");
  }
  const data = (await res.json()) as { items?: CalEvent[] };
  return data.items ?? [];
}

// ---------------------------------------------------------------------------
// Validación de un horario propuesto
// ---------------------------------------------------------------------------

export interface SlotConflict {
  id: string;
  title: string;
  start: string; // hora local del usuario
  end: string;
  kind: "overlap" | "buffer";
}

export interface SlotCheck {
  /** Franjas intocables que pisa el horario (nunca se pueden saltear). */
  blocked: string[];
  /** Eventos que se superponen o que quedan más cerca que el buffer. */
  conflicts: SlotConflict[];
}

const DAY_MS = 86_400_000;

function blockedOverlaps(startNaive: string, endNaive: string, ranges: BlockedRange[]): string[] {
  if (!ranges.length) return [];
  // Todo en "reloj de pared": se compara como si fuera UTC, sin tocar offsets.
  const slotStart = Date.parse(startNaive + "Z");
  const slotEnd = Date.parse(endNaive + "Z");

  const hits: string[] = [];
  const firstDay = Math.floor(slotStart / DAY_MS) - 1; // -1: franjas que cruzan medianoche
  const lastDay = Math.floor(slotEnd / DAY_MS);

  for (let day = firstDay; day <= lastDay; day++) {
    const dayStart = day * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    for (const b of ranges) {
      if (b.dayOfWeek !== weekday) continue;
      const [sh, sm] = b.startTime.split(":").map(Number);
      const [eh, em] = b.endTime.split(":").map(Number);
      const rStart = dayStart + (sh * 60 + sm) * 60_000;
      let rEnd = dayStart + (eh * 60 + em) * 60_000;
      if (rEnd <= rStart) rEnd += DAY_MS; // cruza la medianoche
      if (slotStart < rEnd && slotEnd > rStart) {
        const name = DAY_NAMES[b.dayOfWeek];
        hits.push(`${name} ${b.startTime}-${b.endTime}` + (b.label ? ` (${b.label})` : ""));
      }
    }
  }
  return [...new Set(hits)];
}

export async function checkSlot(opts: {
  accessToken: string;
  start: string; // "YYYY-MM-DDTHH:mm:ss" local
  end: string;
  tz: string;
  settings: AssistantSettings;
  /** Evento que se está moviendo: no cuenta como conflicto consigo mismo. */
  ignoreEventId?: string;
}): Promise<SlotCheck> {
  const { accessToken, start, end, tz, settings, ignoreEventId } = opts;

  const blocked = blockedOverlaps(start, end, settings.blockedHours);

  const bufferMs = settings.bufferMinutes * 60_000;
  const slotStart = localToUtcMs(start, tz);
  const slotEnd = localToUtcMs(end, tz);
  const events = await listEventsBetween(accessToken, slotStart - bufferMs, slotEnd + bufferMs);

  const conflicts: SlotConflict[] = [];
  for (const e of events) {
    if (e.id === ignoreEventId) continue;
    if (e.status === "cancelled") continue;
    if (e.transparency === "transparent") continue; // marcado como "disponible"
    // Los eventos de todo el día (feriados, cumpleaños) no bloquean horarios.
    if (!e.start.dateTime || !e.end.dateTime) continue;

    const evStart = Date.parse(e.start.dateTime);
    const evEnd = Date.parse(e.end.dateTime);
    const overlaps = evStart < slotEnd && evEnd > slotStart;
    const tooClose = evStart < slotEnd + bufferMs && evEnd > slotStart - bufferMs;
    if (!overlaps && !tooClose) continue;

    conflicts.push({
      id: e.id,
      title: e.summary ?? "(sin título)",
      start: utcMsToLocal(evStart, tz),
      end: utcMsToLocal(evEnd, tz),
      kind: overlaps ? "overlap" : "buffer",
    });
  }

  return { blocked, conflicts };
}
