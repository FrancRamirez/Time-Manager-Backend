import { route } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { query } from "../../lib/db";
import type { RescheduleSuggestion } from "../../lib/types";

interface SuggestionRow {
  event_id: string;
  current_starts_at: string;
  current_ends_at: string;
  proposed_starts_at: string;
  proposed_ends_at: string;
  reason: string;
}

export default route(["GET"], async (req, res) => {
  const userId = await requireUser(req);

  const rows = await query<SuggestionRow>(
    `SELECT event_id, current_starts_at, current_ends_at, proposed_starts_at, proposed_ends_at, reason
     FROM suggestions WHERE user_id = ? AND status = 'pending'
     ORDER BY created_at DESC`,
    [userId]
  );

  // Si dos análisis simultáneos crearon la misma sugerencia, se muestra una sola
  // (las filas vienen de la más nueva a la más vieja).
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.event_id) && seen.add(r.event_id));

  const suggestions: RescheduleSuggestion[] = unique.map((r) => ({
    eventId: r.event_id,
    currentSlot: { startsAt: r.current_starts_at, endsAt: r.current_ends_at },
    proposedSlot: { startsAt: r.proposed_starts_at, endsAt: r.proposed_ends_at },
    reason: r.reason,
  }));

  res.status(200).json(suggestions);
});
