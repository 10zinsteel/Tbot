import {
  getCalendarClient,
  normalizeEventResponse,
  listUpcomingEventsForChat,
  listCalendarsForChat,
} from "./googleCalendarService.js";
import { extractCalendarIntent } from "./openaiService.js";
import {
  CALENDAR_CHAT_TIME_ZONE,
  ensureEndDateTime,
  formatEventForChat,
  formatCalendarForChat,
  formatCreatedEventChatReply,
  formatUpcomingEventsReply,
} from "../utils/calendarParser.js";
import {
  registerEvent,
  releaseEvent,
  resolveShortId,
  getShortId,
} from "../utils/eventIdStore.js";

let pendingCalendarAction = null;

function isAffirmative(message) {
  return /^(yes|y|confirm|confirmed|do it|proceed|delete it)\b/i.test(
    message.trim()
  );
}

function isNegative(message) {
  return /^(no|n|stop|cancel|never mind)\b/i.test(message.trim());
}

/**
 * Resolves a user-supplied event identifier to a real Google event ID.
 * Accepts a 6-digit short ID (e.g. "482193" or "[482193]") or a raw Google event ID.
 * Returns null if a short ID was given but is not in the store.
 */
function resolveEventId(rawId) {
  if (!rawId) return null;
  const stripped = rawId.replace(/^\[|\]$/g, "");
  if (/^\d{4}$/.test(stripped)) {
    return resolveShortId(stripped);
  }
  return rawId;
}

/** Registers every event in a list and attaches its shortId field in-place. */
function attachShortIds(events) {
  return events.map((event) => ({
    ...event,
    shortId: registerEvent(event.eventId),
  }));
}

async function handlePendingCalendarAction(message) {
  if (!pendingCalendarAction) return null;

  if (isNegative(message)) {
    const cancelledType = pendingCalendarAction.type;
    pendingCalendarAction = null;
    return `Cancelled the pending ${cancelledType} request.`;
  }

  if (!isAffirmative(message)) {
    if (pendingCalendarAction.type === "deleteEventConfirm") {
      return "Please reply with `confirm` to delete this event, or `cancel` to keep it.";
    }
    if (pendingCalendarAction.type === "deleteCalendarConfirm") {
      return "Please reply with `confirm` to delete this calendar, or `cancel` to keep it.";
    }
    return null;
  }

  const calendar = getCalendarClient();
  if (!calendar) {
    pendingCalendarAction = null;
    return "Google Calendar is not connected. Click `Connect Google Calendar` first.";
  }

  if (pendingCalendarAction.type === "deleteEventConfirm") {
    const { eventId, title, shortId } = pendingCalendarAction.payload;
    await calendar.events.delete({ calendarId: "primary", eventId });
    releaseEvent(eventId);
    pendingCalendarAction = null;
    const idDisplay = shortId ? ` [${shortId}]` : "";
    return `Deleted event${idDisplay} "${title || eventId}".`;
  }

  if (pendingCalendarAction.type === "deleteCalendarConfirm") {
    const { calendarId, summary } = pendingCalendarAction.payload;
    const meta = await calendar.calendars.get({ calendarId });
    if (meta.data?.primary) {
      pendingCalendarAction = null;
      return "Safety check blocked this action: the primary calendar cannot be deleted.";
    }
    await calendar.calendars.delete({ calendarId });
    pendingCalendarAction = null;
    return `Deleted calendar "${summary || calendarId}".`;
  }

  return null;
}

async function handleCalendarChat(message) {
  const pendingReply = await handlePendingCalendarAction(message);
  if (pendingReply) {
    return { handled: true, reply: pendingReply };
  }

  const intent = await extractCalendarIntent(message, CALENDAR_CHAT_TIME_ZONE, new Date());

  if (intent.intent === "unknown") {
    return { handled: false };
  }

  const calendar = getCalendarClient();
  if (!calendar) {
    return {
      handled: true,
      reply: "Google Calendar is not connected. Click `Connect Google Calendar` first.",
    };
  }

  if (intent.intent === "list_events") {
    const events = attachShortIds(await listUpcomingEventsForChat());
    return { handled: true, reply: formatUpcomingEventsReply(events) };
  }

  if (intent.intent === "list_calendars") {
    const calendars = await listCalendarsForChat();
    if (!calendars.length) {
      return { handled: true, reply: "No calendars found." };
    }
    return {
      handled: true,
      reply: `Here are your calendars:\n${calendars.map(formatCalendarForChat).join("\n")}`,
    };
  }

  if (intent.intent === "create_event") {
    if (!intent.title) {
      return { handled: true, reply: "What should I call the event?" };
    }
    if (!intent.start) {
      return { handled: true, reply: "What day and time should it start?" };
    }
    const end = ensureEndDateTime(intent.start, intent.end);
    if (!end) {
      return {
        handled: true,
        reply: "I could not figure out the end time from that start time. Can you try again?",
      };
    }
    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: intent.title,
        start: { dateTime: intent.start, timeZone: CALENDAR_CHAT_TIME_ZONE },
        end: { dateTime: end, timeZone: CALENDAR_CHAT_TIME_ZONE },
        location: intent.location || undefined,
        description: intent.description || undefined,
      },
    });
    const event = normalizeEventResponse(response.data);
    event.shortId = registerEvent(event.eventId);
    return { handled: true, reply: formatCreatedEventChatReply(event) };
  }

  if (intent.intent === "update_event") {
    if (!intent.eventId) {
      const events = attachShortIds(await listUpcomingEventsForChat());
      const listText = events.length
        ? `\n${events.map(formatEventForChat).join("\n")}`
        : "";
      return {
        handled: true,
        reply: `I need an ID to update an event. Here are upcoming events:${listText}\nReply with the [ID] and fields to update.`,
      };
    }
    const realId = resolveEventId(intent.eventId);
    if (!realId) {
      return {
        handled: true,
        reply: "That event ID wasn't recognized. List your events first to get valid IDs.",
      };
    }
    const updates = {};
    if (intent.title) updates.summary = intent.title;
    if (intent.start) updates.start = { dateTime: intent.start };
    if (intent.end) updates.end = { dateTime: intent.end };
    if (intent.location) updates.location = intent.location;
    if (intent.description) updates.description = intent.description;
    if (Object.keys(updates).length === 0) {
      return {
        handled: true,
        reply: "Tell me what to update (title, start, end, location, or description).",
      };
    }
    const response = await calendar.events.patch({
      calendarId: "primary",
      eventId: realId,
      requestBody: updates,
    });
    const event = normalizeEventResponse(response.data);
    const shortId = getShortId(realId);
    const idDisplay = shortId ? ` [${shortId}]` : "";
    return {
      handled: true,
      reply: `Updated event "${event.title}"${idDisplay}.`,
    };
  }

  if (intent.intent === "move_event") {
    if (!intent.eventId) {
      const events = attachShortIds(await listUpcomingEventsForChat());
      const listText = events.length
        ? `\n${events.map(formatEventForChat).join("\n")}`
        : "";
      return {
        handled: true,
        reply: `I need an ID to reschedule an event. Here are upcoming events:${listText}\nReply with the [ID], start, and end.`,
      };
    }
    const realId = resolveEventId(intent.eventId);
    if (!realId) {
      return {
        handled: true,
        reply: "That event ID wasn't recognized. List your events first to get valid IDs.",
      };
    }
    if (!intent.start || !intent.end) {
      return {
        handled: true,
        reply: "To move an event, I need both a new start and end time.",
      };
    }
    const response = await calendar.events.patch({
      calendarId: "primary",
      eventId: realId,
      requestBody: {
        start: { dateTime: intent.start },
        end: { dateTime: intent.end },
      },
    });
    const event = normalizeEventResponse(response.data);
    const shortId = getShortId(realId);
    const idDisplay = shortId ? ` [${shortId}]` : "";
    return {
      handled: true,
      reply: `Rescheduled event "${event.title}"${idDisplay} to ${event.start}.`,
    };
  }

  if (intent.intent === "delete_event") {
    if (!intent.eventId) {
      const events = attachShortIds(await listUpcomingEventsForChat());
      const listText = events.length
        ? `\n${events.map(formatEventForChat).join("\n")}`
        : "";
      return {
        handled: true,
        reply: `I need an ID before deleting an event. Here are upcoming events:${listText}`,
      };
    }
    const realId = resolveEventId(intent.eventId);
    if (!realId) {
      return {
        handled: true,
        reply: "That event ID wasn't recognized. List your events first to get valid IDs.",
      };
    }
    const eventData = await calendar.events.get({
      calendarId: "primary",
      eventId: realId,
    });
    const eventTitle = eventData.data.summary || realId;
    const shortId = getShortId(realId);
    pendingCalendarAction = {
      type: "deleteEventConfirm",
      payload: { eventId: realId, title: eventTitle, shortId },
    };
    const idDisplay = shortId ? `[${shortId}] ` : "";
    return {
      handled: true,
      reply: `Please confirm deletion of event ${idDisplay}"${eventTitle}". Reply with \`confirm\` to proceed or \`cancel\` to abort.`,
    };
  }

  if (intent.intent === "create_calendar") {
    const calSummary = intent.summary || intent.title;
    if (!calSummary) {
      return {
        handled: true,
        reply: 'To create a calendar, provide a name. Example: create a calendar called "Work Projects"',
      };
    }
    const response = await calendar.calendars.insert({
      requestBody: {
        summary: calSummary,
        description: intent.description || undefined,
        timeZone: intent.timeZone || undefined,
      },
    });
    return {
      handled: true,
      reply: `Created calendar "${response.data.summary}" with calendarId: ${response.data.id}`,
    };
  }

  if (intent.intent === "update_calendar") {
    if (!intent.calendarId) {
      const calendars = await listCalendarsForChat();
      return {
        handled: true,
        reply: `I need a calendarId to update a calendar. Here are your calendars:\n${calendars
          .map(formatCalendarForChat)
          .join("\n")}`,
      };
    }
    const updates = {};
    if (intent.summary) updates.summary = intent.summary;
    if (intent.description) updates.description = intent.description;
    if (intent.timeZone) updates.timeZone = intent.timeZone;
    if (Object.keys(updates).length === 0) {
      return {
        handled: true,
        reply: "Provide at least one field to update: summary, description, or timeZone.",
      };
    }
    const response = await calendar.calendars.patch({
      calendarId: intent.calendarId,
      requestBody: updates,
    });
    return {
      handled: true,
      reply: `Updated calendar "${response.data.summary}" (calendarId: ${response.data.id}).`,
    };
  }

  if (intent.intent === "delete_calendar") {
    if (!intent.calendarId) {
      const calendars = await listCalendarsForChat();
      return {
        handled: true,
        reply: `I need a calendarId before deleting a calendar. Here are your calendars:\n${calendars
          .map(formatCalendarForChat)
          .join("\n")}`,
      };
    }
    const meta = await calendar.calendars.get({ calendarId: intent.calendarId });
    if (meta.data?.primary) {
      return {
        handled: true,
        reply: "The primary calendar cannot be deleted. Choose a secondary calendar instead.",
      };
    }
    pendingCalendarAction = {
      type: "deleteCalendarConfirm",
      payload: {
        calendarId: intent.calendarId,
        summary: meta.data?.summary || intent.calendarId,
      },
    };
    return {
      handled: true,
      reply: `Please confirm deletion of calendar "${meta.data?.summary || intent.calendarId}" (calendarId: ${intent.calendarId}). Reply with \`confirm\` to proceed or \`cancel\` to abort.`,
    };
  }

  return {
    handled: true,
    reply:
      "I can help with calendar actions like listing events/calendars, creating/updating/rescheduling events, and managing calendars.",
  };
}

export { handleCalendarChat };
