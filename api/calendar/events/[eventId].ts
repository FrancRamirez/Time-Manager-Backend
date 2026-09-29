import { route, bodyOf, HttpError } from "../../../lib/http";
import { requireUser } from "../../../lib/auth";
import { getGoogleAccessTokenForUser } from "../../../lib/tokens";
import { deleteCalendarEvent } from "../../../lib/google";

export default route(["DELETE"], async (req, res) => {
  const userId = await requireUser(req);
  const eventId = req.query.eventId;
  if (typeof eventId !== "string") {
    throw new HttpError(400, "Falta eventId");
  }

  const body = bodyOf(req);
  if (body.confirmed !== true) {
    // Regla de negocio de la spec: cancelar/borrar exige confirmación explícita.
    throw new HttpError(400, "Esta acción requiere confirmed: true");
  }

  const accessToken = await getGoogleAccessTokenForUser(userId);
  await deleteCalendarEvent(accessToken, eventId);

  res.status(204).end();
});
