const CALENDAR_CHAT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000;

function ensureEndDateTime(start, end) {
  if (end) return end;
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return null;
  return new Date(startDate.getTime() + DEFAULT_EVENT_DURATION_MS).toISOString();
}

function formatEventForChat(event) {
  const start = event.start || "Unknown start";
  return `- ${event.title || "(No title)"} | ${start} | eventId: ${event.eventId}`;
}

function formatCalendarForChat(cal) {
  const primary = cal.primary ? " [primary]" : "";
  return `- ${cal.summary || "(No name)"}${primary} | calendarId: ${cal.calendarId}`;
}

function formatEventStartForUser(start) {
  if (!start) return "an unknown time";
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return start;
  return parsed.toLocaleString("en-US", {
    timeZone: CALENDAR_CHAT_TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCreatedEventChatReply(event) {
  const title = event.title || "Untitled event";
  const when = formatEventStartForUser(event.start);
  const link = event.htmlLink;
  const firstLine = `Created event '${title}' at ${when}.`;
  if (link) {
    return `${firstLine}\nOpen it here: ${link}`;
  }
  return firstLine;
}

function formatUpcomingEventsReply(events) {
  if (!events.length) {
    return "You have no upcoming events.";
  }
  const lines = events.map((event, index) => {
    const title = event.title || "Untitled event";
    const when = formatEventStartForUser(event.start);
    return `${index + 1}. ${title} at ${when}`;
  });
  return `You have ${events.length} upcoming events:\n${lines.join("\n")}`;
}

export {
  CALENDAR_CHAT_TIME_ZONE,
  ensureEndDateTime,
  formatEventForChat,
  formatCalendarForChat,
  formatCreatedEventChatReply,
  formatUpcomingEventsReply,
};
