// ---------------------------------------------------------------------------
// Barrido periódico (IDEA 4A): analiza la agenda de los usuarios con la app cerrada y avisa por push.
//
// Lo dispara un planificador externo gratuito (cron-job.org o GitHub Actions) que llama cada 10-15
// min a /api/cron/scan. El análisis de conflictos es código puro: NO consume cupo de Gemini.
// Cada usuario se atiende en orden de antigüedad del último análisis y con un presupuesto de tiempo,
// así que con muchos usuarios el barrido avanza por turnos sin pasarse del límite de la función.
// ---------------------------------------------------------------------------

import { query, exec } from "./db";
import { HttpError } from "./http";
import { scanUser, type ScanResult } from "./scan";
import { parseSettings, safeTimeZone } from "./schedule";
import { readServiceAccount, sendPush } from "./fcm";

export interface SweepSummary {
  /** false = falta FIREBASE_SERVICE_ACCOUNT: no se analiza nada (ver nota abajo). */
  fcmConfigured: boolean;
  selected: number;
  scanned: number;
  /** Otro barrido ya los atendió hace poco. */
  skipped: number;
  /** Usuarios a los que se les mandó al menos un push. */
  notified: number;
  pushesSent: number;
  tokensRemoved: number;
  /** Usuarios cuya conexión con Google venció: necesitan volver a iniciar sesión en la app. */
  needsLogin: number;
  errors: number;
  /** true = se cortó por el presupuesto de tiempo; quedan usuarios para el próximo barrido. */
  timeBudgetReached: boolean;
  elapsedMs: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Mensaje de datos para la app. Solo lleva lo necesario para armar la notificación (la app pone los
 * textos y los botones). Todo debe ser texto y el total, menos de 4 KB: se recorta con holgura.
 * Devuelve null si no hay nada que avisar.
 */
export function buildScanPush(scan: Pick<ScanResult, "created" | "applied">): Record<string, string> | null {
  if (scan.created.length === 0 && scan.applied.length === 0) return null;
  const data: Record<string, string> = {
    type: "scan",
    a: JSON.stringify(scan.applied.slice(0, 3).map((x) => clip(x.description, 220))),
    n: String(scan.created.length),
  };
  if (scan.created.length === 1) {
    data.e = scan.created[0].eventId.slice(0, 200);
    data.r = clip(scan.created[0].reason, 220);
  }
  return data;
}

interface Row {
  user_id: string;
  settings: unknown;
  time_zone: string;
}

export async function runSweep(
  opts: { maxUsers?: number; budgetMs?: number; concurrency?: number; minGapSeconds?: number } = {}
): Promise<SweepSummary> {
  const { maxUsers = 30, budgetMs = 40_000, concurrency = 4, minGapSeconds = 120 } = opts;
  const started = Date.now();
  const summary: SweepSummary = {
    fcmConfigured: false,
    selected: 0,
    scanned: 0,
    skipped: 0,
    notified: 0,
    pushesSent: 0,
    tokensRemoved: 0,
    needsLogin: 0,
    errors: 0,
    timeBudgetReached: false,
    elapsedMs: 0,
  };

  // Sin FCM no se analiza: scanUser informa cada sugerencia nueva UNA sola vez, y si el servidor la
  // "gastara" sin poder avisar, la tarea del teléfono ya no la notificaría.
  let sa: ReturnType<typeof readServiceAccount> = null;
  try {
    sa = readServiceAccount();
  } catch (err) {
    console.error((err as Error).message);
  }
  if (!sa) return { ...summary, elapsedMs: Date.now() - started };
  summary.fcmConfigured = true;
  const account = sa;

  // Solo usuarios con al menos un dispositivo registrado (sin él no hay a quién avisar).
  const rows = await query<Row>(
    `SELECT s.user_id, s.settings, s.time_zone
       FROM user_settings s
      WHERE EXISTS (SELECT 1 FROM devices d WHERE d.user_id = s.user_id)
      ORDER BY s.last_scan_at IS NOT NULL, s.last_scan_at ASC
      LIMIT ?`,
    [maxUsers]
  );
  summary.selected = rows.length;

  const queue = [...rows];
  async function worker() {
    for (let row = queue.shift(); row; row = queue.shift()) {
      if (Date.now() - started > budgetMs) {
        summary.timeBudgetReached = true;
        return;
      }

      // Reclamo atómico: si otro barrido (reintento del planificador) ya lo atendió, se salta.
      const claim = await exec(
        `UPDATE user_settings SET last_scan_at = NOW()
          WHERE user_id = ? AND (last_scan_at IS NULL OR last_scan_at < NOW() - INTERVAL ? SECOND)`,
        [row.user_id, minGapSeconds]
      );
      if (claim.affectedRows !== 1) {
        summary.skipped++;
        continue;
      }

      try {
        const raw = row.settings;
        const scan = await scanUser({
          userId: row.user_id,
          tz: safeTimeZone(row.time_zone),
          settings: parseSettings(typeof raw === "string" ? JSON.parse(raw) : raw),
        });
        summary.scanned++;

        const data = buildScanPush(scan);
        if (!data) continue;

        const devices = await query<{ fcm_token: string }>(
          "SELECT fcm_token FROM devices WHERE user_id = ?",
          [row.user_id]
        );
        let sentToUser = 0;
        for (const d of devices) {
          const outcome = await sendPush(account, d.fcm_token, data);
          if (outcome === "sent") sentToUser++;
          if (outcome === "unregistered") {
            await exec("DELETE FROM devices WHERE fcm_token = ?", [d.fcm_token]);
            summary.tokensRemoved++;
          }
        }
        summary.pushesSent += sentToUser;
        if (sentToUser > 0) summary.notified++;
      } catch (err) {
        if (err instanceof HttpError && err.extra?.code === "google_reauth") {
          summary.needsLogin++;
        } else {
          summary.errors++;
          console.error(`Barrido: falló el usuario ${row.user_id}:`, (err as Error).message);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  summary.elapsedMs = Date.now() - started;
  return summary;
}
