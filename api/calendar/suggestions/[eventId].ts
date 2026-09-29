import { route, bodyOf, HttpError } from "../../../lib/http";
import { requireUser } from "../../../lib/auth";
import { query, exec } from "../../../lib/db";
import { getGoogleAccessTokenForUser } from "../../../lib/tokens";

interface SuggestionRow {
  id: string;
  proposed_starts_at: string;
  proposed_ends_at: string;
}

export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const eventId = req.query.eventId;
  if (typeof eventId !== "string") {
    throw new HttpError(400, "Falta eventId");
  }

  const body = bodyOf(req);
  if (typeof body.accepted !== "boolean") {
    throw new HttpError(400, "Falta accepted (boolean)");
  }

  const rows = await query<SuggestionRow>(
    `SELECT id, proposed_starts_at, proposed_ends_at FROM suggestions
     WHERE user_id = ? AND event_id = ? AND status = 'pending'`,
    [userId, eventId]
  );
  const suggestion = rows[0];
  if (!suggestion) {
    throw new HttpError(404, "Sugerencia no encontrada o ya resuelta");
  }

  await exec("UPDATE suggestions SET status = ? WHERE id = ?", [
    body.accepted ? "accepted" : "rejected",
    suggestion.id,
  ]);

  if (body.accepted) {
    // TODO: hacer el PATCH real del evento en Google Calendar con el
    // nuevo horario (proposed_starts_at/proposed_ends_at). Por ahora
    // solo confirmamos que las credenciales de Calendar siguen siendo
    // válidas y dejamos la sugerencia marcada como aceptada.
    await getGoogleAccessTokenForUser(userId);
  }

  res.status(200).json({ ok: true });
});
