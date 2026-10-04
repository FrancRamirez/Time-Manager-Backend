import { query, exec } from "./db";
import { parseSettings, safeTimeZone, type AssistantSettings } from "./schedule";

/**
 * Guarda la copia de los ajustes. `parseSettings` valida y normaliza: lo que no sea válido se
 * descarta, así que en la base solo queda un objeto con la forma esperada.
 */
export async function saveUserSettings(
  userId: string,
  rawSettings: unknown,
  rawTimeZone: unknown
): Promise<{ settings: AssistantSettings; timeZone: string }> {
  const settings = parseSettings(rawSettings);
  const timeZone = safeTimeZone(typeof rawTimeZone === "string" ? rawTimeZone : undefined);
  await exec(
    `INSERT INTO user_settings (user_id, settings, time_zone)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE settings = VALUES(settings), time_zone = VALUES(time_zone)`,
    [userId, JSON.stringify(settings), timeZone]
  );
  return { settings, timeZone };
}

export async function loadUserSettings(
  userId: string
): Promise<{ settings: AssistantSettings; timeZone: string } | null> {
  const rows = await query<{ settings: unknown; time_zone: string }>(
    "SELECT settings, time_zone FROM user_settings WHERE user_id = ?",
    [userId]
  );
  if (!rows[0]) return null;
  const raw = rows[0].settings;
  return {
    settings: parseSettings(typeof raw === "string" ? JSON.parse(raw) : raw),
    timeZone: safeTimeZone(rows[0].time_zone),
  };
}
