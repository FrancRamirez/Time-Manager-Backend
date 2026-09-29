import { route, bodyOf, HttpError } from "../../../../lib/http";
import { requireUser } from "../../../../lib/auth";
import { query, exec } from "../../../../lib/db";

interface PendingActionRow {
  id: string;
  type: string;
  payload: unknown;
}

export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const actionId = req.query.actionId;
  if (typeof actionId !== "string") {
    throw new HttpError(400, "Falta actionId");
  }

  const body = bodyOf(req);
  if (typeof body.approve !== "boolean") {
    throw new HttpError(400, "Falta approve (boolean)");
  }

  const rows = await query<PendingActionRow>(
    `SELECT id, type, payload FROM pending_actions
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [actionId, userId]
  );
  const action = rows[0];
  if (!action) {
    throw new HttpError(404, "Acción no encontrada o ya resuelta");
  }

  await exec("UPDATE pending_actions SET status = ? WHERE id = ?", [
    body.approve ? "executed" : "rejected",
    action.id,
  ]);

  // TODO: cuando el chat use function calling de verdad, acá va la
  // ejecución real contra Google Calendar según action.type y action.payload
  // (create | reschedule | cancel).

  res.status(200).json({ ok: true });
});
