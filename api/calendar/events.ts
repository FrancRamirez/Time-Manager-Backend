import { route } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { getGoogleAccessTokenForUser } from "../../lib/tokens";
import { listUpcomingEvents, type GoogleCalendarEvent } from "../../lib/google";
import type { CalendarEvent } from "../../lib/types";

function toApiEvent(e: GoogleCalendarEvent): CalendarEvent {
  return {
    id: e.id,
    title: e.summary ?? "(sin título)",
    startsAt: e.start.dateTime ?? e.start.date ?? new Date().toISOString(),
    endsAt: e.end.dateTime ?? e.end.date ?? new Date().toISOString(),
    location: e.location,
    source: "google_calendar",
    status: e.status === "cancelled" ? "cancelled" : e.status === "tentative" ? "tentative" : "confirmed",
  };
}

export default route(["GET"], async (req, res) => {
  const userId = await requireUser(req);
  const days = Number(req.query.days ?? 7);

  const accessToken = await getGoogleAccessTokenForUser(userId);
  const events = await listUpcomingEvents(accessToken, Number.isFinite(days) ? days : 7);

  res.status(200).json(events.map(toApiEvent));
});
