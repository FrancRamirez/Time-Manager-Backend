import { randomUUID } from "node:crypto";
import { query, exec } from "./db";
import { getGoogleAccessTokenForUser } from "./tokens";
import { patchCalendarEvent } from "./google";
import { tr } from "./lang";
import {
  listEventsBetween,
  localToUtcMs,
  utcMsToLocal,
  formatWhen,
  type AssistantSettings,
} from "./schedule";
import {
  planSuggestions,
  reconcile,
  toPlannerEvent,
  SEARCH_DAYS,
  type ExistingSuggestion,
  type PlannerEvent,
} from "./conflicts";

const DAY_MS = 86_400_000;

interface SuggestionRow {
  id: string;
  event_id: string;
  current_starts_at: string;
  proposed_starts_at: string;
  proposed_ends_at: string;
  status: "pending" | "rejected";
}

export interface ScanResult {
  /** Sugerencias nuevas (todavía sin avisar al usuario). */
  created: { eventId: string; reason: string }[];
  /** Cambios que el Piloto Automático ya aplicó en el calendario. */
  applied: { eventId: string; title: string; from: string; to: string; description: string }[];
  /** Sugerencias pendientes después de este análisis. */
  pending: number;
  /** Conflictos para los que no hay hueco o que no se pueden mover. */
  unresolved: number;
}

/** Cuántas acciones automáticas se aplicaron hoy (día local), compartido con el chat. */
async function autoActionsToday(userId: string, tz: string): Promise<number> {
  const today = utcMsToLocal(Date.now(), tz).slice(0, 10);
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - localToUtcMs(`${today}T00:00:00`, tz)) / 1000)
  );
  const rows = await query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM pending_actions
     WHERE user_id = ? AND status = 'auto_done'
       AND created_at >= NOW() - INTERVAL ? SECOND`,
    [userId, elapsedSeconds]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Analiza la agenda de los próximos días, detecta conflictos (superposiciones y
 * eventos que no respetan el buffer), guarda las sugerencias de reprogramación
 * y, en modo Piloto Automático, aplica las que son seguras.
 *
 * Es idempotente: se puede llamar cada pocos minutos sin duplicar sugerencias ni
 * volver a ofrecer lo que el usuario ya ignoró.
 */
export async function scanUser(opts: {
  userId: string;
  tz: string;
  settings: AssistantSettings;
}): Promise<ScanResult> {
  const { userId, tz, settings } = opts;

  // El usuario restringió Calendar (solo lectura o bloqueada): el motor existe para MOVER eventos,
  // así que no se analiza ni se mueve nada (tampoco el Piloto Automático) y se retiran las
  // sugerencias pendientes para que la Agenda no ofrezca botones que no se pueden usar.
  if (settings.appAccess.calendar !== "allowed") {
    await exec("UPDATE suggestions SET status = 'stale' WHERE user_id = ? AND status = 'pending'", [
      userId,
    ]);
    return { created: [], applied: [], pending: 0, unresolved: 0 };
  }

  const accessToken = await getGoogleAccessTokenForUser(userId);

  const now = Date.now();
  const rawEvents = await listEventsBetween(accessToken, now, now + SEARCH_DAYS * DAY_MS, 250);
  const events = rawEvents.map(toPlannerEvent).filter((e): e is PlannerEvent => e !== null);
  const titles = new Map(events.map((e) => [e.id, e.title]));

  const plan = planSuggestions({ events, settings, tz, nowMs: now });

  // --- Estado guardado ------------------------------------------------------
  const stored = await query<SuggestionRow>(
    `SELECT id, event_id, current_starts_at, proposed_starts_at, proposed_ends_at, status
     FROM suggestions
     WHERE user_id = ?
       AND (status = 'pending' OR (status = 'rejected' AND created_at > NOW() - INTERVAL 30 DAY))
     ORDER BY created_at DESC`,
    [userId]
  );
  const existing: ExistingSuggestion[] = stored.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    currentStart: Date.parse(r.current_starts_at),
    proposedStart: Date.parse(r.proposed_starts_at),
    proposedEnd: Date.parse(r.proposed_ends_at),
    status: r.status,
  }));

  const rec = reconcile(existing, plan.moves);
  const iso = (ms: number) => new Date(ms).toISOString();

  for (const row of rec.rows) {
    const m = row.move;
    if (row.action === "insert") {
      await exec(
        `INSERT INTO suggestions
           (id, user_id, event_id, current_starts_at, current_ends_at,
            proposed_starts_at, proposed_ends_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, userId, m.eventId, iso(m.from.start), iso(m.from.end), iso(m.to.start), iso(m.to.end), m.reason]
      );
    } else if (row.action === "update") {
      await exec(
        `UPDATE suggestions
         SET current_starts_at = ?, current_ends_at = ?, proposed_starts_at = ?,
             proposed_ends_at = ?, reason = ?
         WHERE id = ? AND status = 'pending'`,
        [iso(m.from.start), iso(m.from.end), iso(m.to.start), iso(m.to.end), m.reason, row.id]
      );
    }
  }
  for (const id of rec.stale) {
    await exec("UPDATE suggestions SET status = 'stale' WHERE id = ? AND status = 'pending'", [id]);
  }

  // --- Piloto Automático ----------------------------------------------------
  const applied: ScanResult["applied"] = [];
  if (settings.autonomyLevel === "autopilot") {
    let remaining = settings.dailyActionLimit - (await autoActionsToday(userId, tz));

    // Se aplican en el mismo orden en que se planificaron: cada movimiento ya
    // tuvo en cuenta a los anteriores.
    for (const row of rec.rows) {
      const m = row.move;
      if (remaining <= 0) break;
      if (!m.autoSafe) continue; // con invitados o recurrente: lo decide el usuario

      // Reclamo atómico: si otro análisis simultáneo ya la tomó, no se repite.
      const claim = await exec(
        "UPDATE suggestions SET status = 'auto_applied' WHERE id = ? AND status = 'pending'",
        [row.id]
      );
      if (claim.affectedRows !== 1) continue;

      try {
        await patchCalendarEvent(accessToken, m.eventId, {
          start: utcMsToLocal(m.to.start, tz),
          end: utcMsToLocal(m.to.end, tz),
          timeZone: tz,
        });
      } catch (err) {
        console.error("Piloto Automático: no se pudo mover el evento", m.eventId, err);
        await exec("UPDATE suggestions SET status = 'pending' WHERE id = ?", [row.id]);
        break; // los movimientos siguientes dependían del orden: se frena acá
      }

      const description = tr(
        `"${m.title}" pasó de ${formatWhen(m.from.start, tz)} a ${formatWhen(m.to.start, tz)} (${m.detail})`,
        `"${m.title}" moved from ${formatWhen(m.from.start, tz)} to ${formatWhen(m.to.start, tz)} (${m.detail})`
      );
      await exec(
        `INSERT INTO pending_actions (id, user_id, type, description, payload, status)
         VALUES (?, ?, 'reschedule', ?, ?, 'auto_done')`,
        [
          randomUUID(),
          userId,
          description,
          JSON.stringify({
            eventId: m.eventId,
            title: m.title,
            start: utcMsToLocal(m.to.start, tz),
            end: utcMsToLocal(m.to.end, tz),
            timeZone: tz,
            source: "conflict-scan",
          }),
        ]
      );
      remaining -= 1;
      applied.push({
        eventId: m.eventId,
        title: titles.get(m.eventId) ?? m.title,
        from: iso(m.from.start),
        to: iso(m.to.start),
        description,
      });
    }
  }

  const appliedIds = new Set(applied.map((a) => a.eventId));
  const created = rec.rows
    .filter((r) => r.action === "insert" && !appliedIds.has(r.move.eventId))
    .map((r) => ({ eventId: r.move.eventId, reason: r.move.reason }));
  const pending = rec.rows.filter((r) => !appliedIds.has(r.move.eventId)).length;

  return { created, applied, pending, unresolved: plan.unresolved.length };
}
