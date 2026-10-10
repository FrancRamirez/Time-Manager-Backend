import { randomUUID } from "node:crypto";
import { tr } from "./lang";
import {
  blockedOverlaps,
  formatWhen,
  localToUtcMs,
  slotBlockers,
  utcMsToLocal,
  type AssistantSettings,
  type CalEvent,
} from "./schedule";

// ---------------------------------------------------------------------------
// Parámetros del motor
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MIN = 60_000;

/** No se mueven eventos que empiezan en menos de este tiempo (ya van a asistir). */
export const MIN_LEAD_MS = 30 * MIN;
/** Cuántos días hacia adelante se buscan conflictos. */
export const DETECT_DAYS = 7;
/** Cuántos días hacia adelante se buscan huecos libres para reubicar. */
export const SEARCH_DAYS = 14;
/** Un evento solo se reubica hasta este número de días después de su fecha original. */
const MAX_SHIFT_DAYS = 7;
/** Horario "razonable" para reubicar eventos (futuro ajuste de usuario). */
const WINDOW_START_MIN = 8 * 60;
const WINDOW_END_MIN = 21 * 60;
const STEP_MIN = 15;
const MAX_ITERATIONS = 30;
/**
 * true: también se marcan eventos pegados que no respetan el buffer.
 * false: solo se marcan superposiciones reales.
 */
export const FLAG_BUFFER_CONFLICTS = true;

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

export interface PlannerEvent {
  id: string;
  title: string;
  start: number; // ms UTC
  end: number;
  /** Se puede mover (evento propio, de tipo normal, sin restricciones de edición). */
  movable: boolean;
  /** Tiene otros invitados: moverlo afecta a otras personas. */
  hasGuests: boolean;
  /** Es una instancia de un evento recurrente. */
  recurring: boolean;
  tentative: boolean;
}

export interface PlannedMove {
  eventId: string;
  title: string;
  from: { start: number; end: number };
  to: { start: number; end: number };
  conflictWith: { id: string; title: string; kind: "overlap" | "buffer" };
  /** Texto completo para la sugerencia (la app solo muestra este campo). */
  reason: string;
  /** Explicación corta del conflicto, para avisos del Piloto Automático. */
  detail: string;
  /** Se puede aplicar solo en Piloto Automático: sin invitados y no recurrente. */
  autoSafe: boolean;
}

export interface UnresolvedConflict {
  titles: [string, string];
  why: "no_movable" | "no_slot";
}

export interface PlanResult {
  moves: PlannedMove[];
  unresolved: UnresolvedConflict[];
}

// ---------------------------------------------------------------------------
// Google Calendar -> modelo del planificador
// ---------------------------------------------------------------------------

/** Devuelve null si el evento no ocupa tiempo (cancelado, todo el día, "disponible"...). */
export function toPlannerEvent(e: CalEvent): PlannerEvent | null {
  if (e.status === "cancelled") return null;
  if (e.transparency === "transparent") return null; // marcado como "disponible"
  if (!e.start.dateTime || !e.end.dateTime) return null; // todo el día: no bloquea
  if (e.eventType === "workingLocation") return null; // informativo

  const attendees = e.attendees ?? [];
  if (attendees.find((a) => a.self)?.responseStatus === "declined") return null;

  const start = Date.parse(e.start.dateTime);
  const end = Date.parse(e.end.dateTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;

  const hasGuests = attendees.some((a) => !a.self);
  const isOrganizer = e.organizer?.self === true;
  const normalType = !e.eventType || e.eventType === "default";
  // Con invitados, solo el organizador (o si los invitados pueden modificarlo) puede moverlo.
  const canEdit = !hasGuests || isOrganizer || e.guestsCanModify === true;

  return {
    id: e.id,
    title: e.summary ?? "(sin título)",
    start,
    end,
    movable: normalType && canEdit && e.locked !== true,
    hasGuests,
    recurring: Boolean(e.recurringEventId),
    tentative: e.status === "tentative",
  };
}

// ---------------------------------------------------------------------------
// Planificador (función pura: sin red ni base de datos)
// ---------------------------------------------------------------------------

function addDays(dateStr: string, n: number): string {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function hhmm(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutesOfDay(naive: string): number {
  return Number(naive.slice(11, 13)) * 60 + Number(naive.slice(14, 16));
}

export function planSuggestions(input: {
  events: PlannerEvent[];
  settings: AssistantSettings;
  tz: string;
  nowMs: number;
}): PlanResult {
  const { settings, tz, nowMs } = input;
  const bufferMs = FLAG_BUFFER_CONFLICTS ? settings.bufferMinutes * MIN : 0;
  // El buffer también cuenta al buscar huecos, aunque no se marquen los pegados.
  const slotBufferMs = settings.bufferMinutes * MIN;
  const minStart = nowMs + MIN_LEAD_MS;
  const detectEnd = nowMs + DETECT_DAYS * DAY_MS;
  const searchEnd = nowMs + SEARCH_DAYS * DAY_MS;

  const work = input.events.map((e) => ({ ...e })); // posiciones que se van actualizando
  const moved = new Set<string>();
  const givenUp = new Set<string>();
  const moves: PlannedMove[] = [];
  const unresolved: UnresolvedConflict[] = [];

  // Eventos que ya están dentro de una franja intocable: no se tocan.
  const protectedIds = new Set<string>();
  if (settings.blockedHours.length) {
    for (const e of work) {
      const hits = blockedOverlaps(
        utcMsToLocal(e.start, tz),
        utcMsToLocal(e.end, tz),
        settings.blockedHours
      );
      if (hits.length) protectedIds.add(e.id);
    }
  }

  const canMove = (e: PlannerEvent) =>
    e.movable && !moved.has(e.id) && !protectedIds.has(e.id) && e.start >= minStart;

  /** Menor costo = mejor candidato a moverse. */
  const cost = (e: PlannerEvent, other: PlannerEvent) =>
    (e.hasGuests ? 100 : 0) +
    (e.recurring ? 40 : 0) +
    (e.start < other.start ? 15 : 0) + // se prefiere mover el que empieza después
    (e.end - e.start) / (15 * MIN) - // y el más corto
    (e.tentative ? 10 : 0);

  function firstConflict(): { a: PlannerEvent; b: PlannerEvent; kind: "overlap" | "buffer" } | null {
    const sorted = [...work].sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (a.start >= detectEnd) break;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (b.start >= a.end + bufferMs) continue; // sin conflicto con este
        const key = [a.id, b.id].sort().join("|");
        if (givenUp.has(key)) continue;
        return { a, b, kind: b.start < a.end ? "overlap" : "buffer" };
      }
    }
    return null;
  }

  /** Mejor hueco libre para `e` (el más cercano a su horario original), o null. */
  function findSlot(e: PlannerEvent): { start: number; end: number } | null {
    const durMs = e.end - e.start;
    const durMin = Math.max(1, Math.round(durMs / MIN));
    const origStart = utcMsToLocal(e.start, tz);
    const origEnd = utcMsToLocal(e.end, tz);

    // Si el original queda fuera del horario razonable, la ventana lo incluye.
    const winStart = Math.min(WINDOW_START_MIN, minutesOfDay(origStart));
    const sameDay = origEnd.slice(0, 10) === origStart.slice(0, 10);
    const winEnd = Math.max(WINDOW_END_MIN, sameDay ? minutesOfDay(origEnd) : 24 * 60);

    const firstDay = utcMsToLocal(nowMs, tz).slice(0, 10);
    const lastDay = addDays(origStart.slice(0, 10), MAX_SHIFT_DAYS);
    const others = work.filter((x) => x.id !== e.id);

    let best: { start: number; end: number } | null = null;
    let bestDist = Infinity;

    for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
      const base = localToUtcMs(`${day}T${hhmm(winStart)}:00`, tz);
      for (let m = winStart; m + durMin <= winEnd; m += STEP_MIN) {
        const start = base + (m - winStart) * MIN;
        const end = start + durMs;
        if (start < minStart || end > searchEnd) continue;

        const dist = Math.abs(start - e.start);
        // Empate: se prefiere el horario posterior al original.
        if (dist > bestDist || (dist === bestDist && start < e.start)) continue;

        if (slotBlockers(start, end, others, slotBufferMs).length) continue;
        if (settings.blockedHours.length) {
          const startNaive = `${day}T${hhmm(m)}:00`;
          const endNaive = new Date(Date.parse(startNaive + "Z") + durMin * MIN)
            .toISOString()
            .slice(0, 19);
          if (blockedOverlaps(startNaive, endNaive, settings.blockedHours).length) continue;
        }

        best = { start, end };
        bestDist = dist;
      }
    }
    return best;
  }

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const c = firstConflict();
    if (!c) break;

    const candidates = [
      { e: c.a, other: c.b },
      { e: c.b, other: c.a },
    ]
      .filter(({ e }) => canMove(e))
      .sort((x, y) => cost(x.e, x.other) - cost(y.e, y.other));

    let resolved = false;
    for (const { e, other } of candidates) {
      const slot = findSlot(e);
      if (!slot) continue;

      const detail =
        c.kind === "overlap"
          ? tr(`se superpone con "${other.title}"`, `overlaps with "${other.title}"`)
          : tr(`queda a menos de ${settings.bufferMinutes} min de "${other.title}"`, `is less than ${settings.bufferMinutes} min from "${other.title}"`);

      moves.push({
        eventId: e.id,
        title: e.title,
        from: { start: e.start, end: e.end },
        to: slot,
        conflictWith: { id: other.id, title: other.title, kind: c.kind },
        reason: tr(
          `Mover "${e.title}" de ${formatWhen(e.start, tz)} a ${formatWhen(slot.start, tz)}: ${detail}.`,
          `Move "${e.title}" from ${formatWhen(e.start, tz)} to ${formatWhen(slot.start, tz)}: ${detail}.`
        ),
        detail,
        autoSafe: !e.hasGuests && !e.recurring,
      });
      e.start = slot.start; // `e` es la copia de trabajo: los siguientes choques ya lo ven movido
      e.end = slot.end;
      moved.add(e.id);
      resolved = true;
      break;
    }

    if (!resolved) {
      givenUp.add([c.a.id, c.b.id].sort().join("|"));
      unresolved.push({
        titles: [c.a.title, c.b.title],
        why: candidates.length ? "no_slot" : "no_movable",
      });
    }
  }

  return { moves, unresolved };
}

// ---------------------------------------------------------------------------
// Sincronización con la tabla `suggestions` (función pura)
// ---------------------------------------------------------------------------

export interface ExistingSuggestion {
  id: string;
  eventId: string;
  currentStart: number; // ms
  proposedStart: number;
  proposedEnd: number;
  status: "pending" | "rejected";
}

export interface ReconciledRow {
  id: string;
  move: PlannedMove;
  action: "insert" | "update" | "keep";
}

/**
 * Compara lo que ya hay guardado con lo que calculó el motor:
 *  - no vuelve a sugerir lo que el usuario ya ignoró (mismo evento, mismo horario);
 *  - conserva las sugerencias vigentes sin tocarlas (no se notifican de nuevo);
 *  - actualiza las que cambiaron de propuesta;
 *  - marca como obsoletas las que ya no aplican (conflicto resuelto o evento movido).
 * `existing` debe venir ordenado de la más nueva a la más vieja.
 */
export function reconcile(
  existing: ExistingSuggestion[],
  planned: PlannedMove[],
  newId: () => string = randomUUID
): { rows: ReconciledRow[]; stale: string[]; skipped: PlannedMove[] } {
  const rejected = new Set(
    existing.filter((x) => x.status === "rejected").map((x) => `${x.eventId}|${x.currentStart}`)
  );
  const pendingByEvent = new Map<string, ExistingSuggestion[]>();
  for (const x of existing) {
    if (x.status !== "pending") continue;
    const list = pendingByEvent.get(x.eventId) ?? [];
    list.push(x);
    pendingByEvent.set(x.eventId, list);
  }

  const rows: ReconciledRow[] = [];
  const skipped: PlannedMove[] = [];
  const keptIds = new Set<string>();

  for (const m of planned) {
    if (rejected.has(`${m.eventId}|${m.from.start}`)) {
      skipped.push(m);
      continue;
    }
    const current = pendingByEvent.get(m.eventId)?.[0];
    if (!current) {
      rows.push({ id: newId(), move: m, action: "insert" });
      continue;
    }
    keptIds.add(current.id);
    const same =
      current.currentStart === m.from.start &&
      current.proposedStart === m.to.start &&
      current.proposedEnd === m.to.end;
    rows.push({ id: current.id, move: m, action: same ? "keep" : "update" });
  }

  const stale = existing
    .filter((x) => x.status === "pending" && !keptIds.has(x.id))
    .map((x) => x.id);

  return { rows, stale, skipped };
}
