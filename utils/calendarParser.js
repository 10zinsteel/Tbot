const CALENDAR_CHAT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000;

function ensureEndDateTime(start, end) {
  if (end) return end;
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return null;
  return new Date(startDate.getTime() + DEFAULT_EVENT_DURATION_MS).toISOString();
}

// Expects event.shortId to be set by the caller before formatting.
function formatEventForChat(event) {
  const when = formatEventStartForUser(event.start);
  const id = event.shortId ? `[${event.shortId}]` : "";
  return `${id} ${event.title || "(No title)"} | ${when}`;
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

// Expects event.shortId to be set by the caller before formatting.
function formatCreatedEventChatReply(event) {
  const title = event.title || "Untitled event";
  const when = formatEventStartForUser(event.start);
  const idDisplay = event.shortId ? ` [${event.shortId}]` : "";
  const firstLine = `Created event '${title}'${idDisplay} at ${when}.`;
  if (event.htmlLink) {
    return `${firstLine}\nOpen it here: ${event.htmlLink}`;
  }
  return firstLine;
}

// Expects each event to have event.shortId set by the caller before formatting.
function formatUpcomingEventsReply(events) {
  if (!events.length) return "You have no upcoming events.";
  const lines = events.map((event) => {
    const title = event.title || "Untitled event";
    const when = formatEventStartForUser(event.start);
    const id = event.shortId ? `[${event.shortId}]` : "";
    return `${id} ${title} at ${when}`;
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
