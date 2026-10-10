import { HttpError } from "./http";
import { tfetch } from "./timing";
import type { GoogleCalendarEvent } from "./google";
import { DEFAULT_APP_ACCESS, parseAppAccess, type AppAccess } from "./access";
import { DEFAULT_RESPONSE_LEVEL, parseResponseLevel, type ResponseLevel } from "./responseLevel";
import { currentLang, parseLang, type Lang } from "./lang";

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
  /** Qué puede tocar el asistente en cada app (Permitido / Solo lectura / Bloqueada). */
  appAccess: AppAccess;
  /** Cuánto "trabaja" Frami por respuesta: Baja (1 solicitud a la IA), Media (hasta 3) o Alta (las necesarias, con tope). */
  responseLevel: ResponseLevel;
  /** Idioma de la app: los avisos con la app cerrada y las respuestas usan este idioma. */
  language: Lang;
}

export const DEFAULT_SETTINGS: AssistantSettings = {
  autonomyLevel: "suggestion",
  bufferMinutes: 0,
  dailyActionLimit: 100,
  blockedHours: [],
  appAccess: DEFAULT_APP_ACCESS,
  responseLevel: DEFAULT_RESPONSE_LEVEL,
  language: "es",
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
    appAccess: parseAppAccess(r.appAccess),
    responseLevel: parseResponseLevel(r.responseLevel),
    language: parseLang(r.language),
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

export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("es", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
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

/** Evento de Google Calendar con los campos extra que usa el motor de conflictos. */
/**
 * Campos que usan el análisis de conflictos y la validación de horarios (ver CalEvent). Los invitados
 * solo se piden con `self` y `responseStatus`: no se descargan correos ni nombres.
 */
export const WINDOW_FIELDS =
  "items(id,summary,location,status,start(dateTime,date),end(dateTime,date)," +
  "transparency,eventType,recurringEventId,guestsCanModify,locked,organizer(self)," +
  "attendees(self,responseStatus))";

export type CalEvent = GoogleCalendarEvent & {
  transparency?: string;
  eventType?: string;
  recurringEventId?: string;
  guestsCanModify?: boolean;
  locked?: boolean;
  organizer?: { self?: boolean };
  attendees?: { self?: boolean; responseStatus?: string }[];
};

export async function listEventsBetween(
  accessToken: string,
  fromMs: number,
  toMs: number,
  maxResults = 100
): Promise<CalEvent[]> {
  const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
  url.searchParams.set("timeMin", new Date(fromMs).toISOString());
  url.searchParams.set("timeMax", new Date(toMs).toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("fields", WINDOW_FIELDS);

  const res = await tfetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
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

export function blockedOverlaps(startNaive: string, endNaive: string, ranges: BlockedRange[]): string[] {
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

/** Intervalo ocupado (milisegundos UTC). */
export interface BusyBlock {
  id: string;
  start: number;
  end: number;
}

/**
 * Qué bloques ocupados impiden un horario: los que se superponen y los que
 * quedan más cerca que el buffer. Función pura (sin red): la usan tanto la
 * validación de un horario como la búsqueda de huecos del motor de conflictos.
 */
export function slotBlockers(
  slotStart: number,
  slotEnd: number,
  busy: BusyBlock[],
  bufferMs: number,
  ignoreId?: string
): { id: string; kind: "overlap" | "buffer" }[] {
  const out: { id: string; kind: "overlap" | "buffer" }[] = [];
  for (const b of busy) {
    if (b.id === ignoreId) continue;
    const overlaps = b.start < slotEnd && b.end > slotStart;
    const tooClose = b.start < slotEnd + bufferMs && b.end > slotStart - bufferMs;
    if (overlaps || tooClose) out.push({ id: b.id, kind: overlaps ? "overlap" : "buffer" });
  }
  return out;
}

/** "vie 2 oct, 15:45" (o "Fri, Oct 2, 3:45 PM" en inglés) en la zona del usuario. */
export function formatWhen(ms: number, tz: string): string {
  const en = currentLang() === "en";
  return new Intl.DateTimeFormat(en ? "en-US" : "es", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: en,
    timeZone: tz,
  }).format(new Date(ms));
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

  const byId = new Map<string, { title: string; start: number; end: number }>();
  const busy: BusyBlock[] = [];
  for (const e of events) {
    if (e.status === "cancelled") continue;
    if (e.transparency === "transparent") continue; // marcado como "disponible"
    // Los eventos de todo el día (feriados, cumpleaños) no bloquean horarios.
    if (!e.start.dateTime || !e.end.dateTime) continue;
    const evStart = Date.parse(e.start.dateTime);
    const evEnd = Date.parse(e.end.dateTime);
    busy.push({ id: e.id, start: evStart, end: evEnd });
    byId.set(e.id, { title: e.summary ?? "(sin título)", start: evStart, end: evEnd });
  }

  const conflicts: SlotConflict[] = slotBlockers(slotStart, slotEnd, busy, bufferMs, ignoreEventId).map(
    ({ id, kind }) => {
      const ev = byId.get(id)!;
      return {
        id,
        title: ev.title,
        start: utcMsToLocal(ev.start, tz),
        end: utcMsToLocal(ev.end, tz),
        kind,
      };
    }
  );

  return { blocked, conflicts };
}
