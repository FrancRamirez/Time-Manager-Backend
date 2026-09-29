export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  source: "google_calendar" | "gmail_detected" | "manual";
  status: "confirmed" | "tentative" | "cancelled";
}

export interface RescheduleSuggestion {
  eventId: string;
  currentSlot: { startsAt: string; endsAt: string };
  proposedSlot: { startsAt: string; endsAt: string };
  reason: string;
}
