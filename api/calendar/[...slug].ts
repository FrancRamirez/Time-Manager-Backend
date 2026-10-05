import { dispatcher } from "../../lib/dispatch";
import { calendarRoutes } from "../../lib/routes";

// /api/calendar/events[/:eventId], /scan, /suggestions[/:eventId] (una sola función)
export default dispatcher("/api/calendar/", calendarRoutes);
