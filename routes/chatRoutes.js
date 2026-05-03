import express from "express";
import { getOpenAIChatReply } from "../services/openaiService.js";
import {
  conversationHistory,
  trimConversationHistory,
  resetConversationHistory,
} from "../services/memoryService.js";
import {
  getCalendarClient,
  normalizeEventResponse,
  listUpcomingEventsForChat,
  listCalendarsForChat,
} from "../services/googleCalendarService.js";
import {
  CALENDAR_CHAT_TIME_ZONE,
  looksLikeFreeformCreateEvent,
  parseNaturalCreateEvent,
  followUpForMissingCreateFields,
  isReasonableDateTimeString,
  ensureEndDateTime,
  utcInstantToRfc3339InZone,
  formatEventForChat,
  formatCalendarForChat,
  isCalendarReadQuery,
  formatCreatedEventChatReply,
  formatUpcomingEventsReply,
} from "../utils/calendarParser.js";

const router = express.Router();
let pendingCalendarAction = null;

function isCalendarIntent(message) {
  const text = message.toLowerCase();
  if (pendingCalendarAction) return true;
  return (
    text.includes("calendar") ||
    text.includes("event") ||
    text.includes("schedule") ||
    text.includes("reschedule") ||
    looksLikeFreeformCreateEvent(message)
  );
}

function isAffirmative(message) {
  return /^(yes|y|confirm|confirmed|do it|proceed|delete it)\b/i.test(
    message.trim()
  );
}

function isNegative(message) {
  return /^(no|n|stop|cancel|never mind)\b/i.test(message.trim());
}

function readField(message, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `\\b${escaped}\\b\\s*(?:=|:|is)?\\s*(?:"([^"]+)"|'([^']+)'|([^,;\\n]+))`,
    "i"
  );
  const match = message.match(regex);
  return (match?.[1] || match?.[2] || match?.[3] || "").trim() || null;
}

function readEventId(message) {
  return (
    readField(message, "eventId") ||
    readField(message, "event id") ||
    null
  );
}

function readCalendarId(message) {
  return (
    readField(message, "calendarId") ||
    readField(message, "calendar id") ||
    null
  );
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
    const { eventId, title } = pendingCalendarAction.payload;
    await calendar.events.delete({ calendarId: "primary", eventId });
    pendingCalendarAction = null;
    return `Deleted event "${title || eventId}".`;
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

  if (!isCalendarIntent(message)) {
    return { handled: false };
  }

  const calendar = getCalendarClient();
  if (!calendar) {
    return {
      handled: true,
      reply: "Google Calendar is not connected. Click `Connect Google Calendar` first.",
    };
  }

  const text = message.toLowerCase();
  const wantsEventsList =
    /(show|list|what|upcoming|next)\b/.test(text) &&
    /(event|events|calendar)/.test(text) &&
    !/(delete|remove|cancel|create|add|edit|update|move|reschedule)/.test(text);

  if (wantsEventsList) {
    const events = await listUpcomingEventsForChat();
    if (!events.length) {
      return { handled: true, reply: "No upcoming events found." };
    }
    return {
      handled: true,
      reply: `Here are your next ${events.length} events:\n${events
        .map(formatEventForChat)
        .join("\n")}`,
    };
  }

  const wantsCalendarList =
    /(show|list|what)\b/.test(text) &&
    /calendars/.test(text) &&
    !/(delete|remove|create|add|edit|update)/.test(text);

  if (wantsCalendarList) {
    const calendars = await listCalendarsForChat();
    if (!calendars.length) {
      return { handled: true, reply: "No calendars found." };
    }
    return {
      handled: true,
      reply: `Here are your calendars:\n${calendars.map(formatCalendarForChat).join("\n")}`,
    };
  }

  const wantsCreateEvent =
    (/(create|add)\b/.test(text) &&
      /\b(event|meeting|appointment)\b/.test(text)) ||
    (/schedule\b/.test(text) &&
      !/\breschedule\b/.test(text) &&
      /\b(event|meeting|appointment)\b/.test(text)) ||
    looksLikeFreeformCreateEvent(message);

  if (wantsCreateEvent) {
    let title = readField(message, "title");
    let start = readField(message, "start");
    let end = readField(message, "end");
    const location = readField(message, "location");
    const description = readField(message, "description");
    let naturalDateYmd = null;
    let naturalTimeHm = null;

    if (!title || !start) {
      const nl = parseNaturalCreateEvent(
        message,
        CALENDAR_CHAT_TIME_ZONE,
        new Date()
      );
      if (!title && nl.title) title = nl.title;
      naturalDateYmd = nl.dateYmd || null;
      naturalTimeHm = nl.timeHm || null;
      if (!start && nl.startUtc) {
        start = utcInstantToRfc3339InZone(
          nl.startUtc,
          CALENDAR_CHAT_TIME_ZONE
        );
      }
    }

    if (!title || !start) {
      const followUp = followUpForMissingCreateFields(
        title,
        naturalDateYmd,
        naturalTimeHm,
        start
      );
      return {
        handled: true,
        reply:
          followUp ||
          "What would you like to call the event, and what day and time should it start?",
      };
    }

    if (!isReasonableDateTimeString(start)) {
      return {
        handled: true,
        reply: title
          ? "I could not read that time. What day and time should it start?"
          : followUpForMissingCreateFields(null, null, null, null),
      };
    }

    end = ensureEndDateTime(start, end, CALENDAR_CHAT_TIME_ZONE);
    if (!end) {
      return {
        handled: true,
        reply:
          "I could not figure out the end time from that start time. Can you try the time again?",
      };
    }

    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        start: { dateTime: start, timeZone: CALENDAR_CHAT_TIME_ZONE },
        end: { dateTime: end, timeZone: CALENDAR_CHAT_TIME_ZONE },
        location: location || undefined,
        description: description || undefined,
      },
    });

    console.log(
      "[calendar] chat create events.insert full response:",
      JSON.stringify(response.data, null, 2)
    );

    const event = normalizeEventResponse(response.data);
    return {
      handled: true,
      reply: formatCreatedEventChatReply(event),
    };
  }

  if (/(edit|update)\b/.test(text) && /(event)/.test(text)) {
    const eventId = readEventId(message);
    const title = readField(message, "title");
    const start = readField(message, "start");
    const end = readField(message, "end");
    const location = readField(message, "location");
    const description = readField(message, "description");

    const updates = {};
    if (title !== null) updates.summary = title;
    if (start !== null) updates.start = { dateTime: start };
    if (end !== null) updates.end = { dateTime: end };
    if (location !== null) updates.location = location;
    if (description !== null) updates.description = description;

    if (!eventId) {
      const events = await listUpcomingEventsForChat();
      const listText = events.length
        ? `\n${events.map(formatEventForChat).join("\n")}`
        : "";
      return {
        handled: true,
        reply: `I need an eventId to edit an event. Here are upcoming events:${listText}\nReply with eventId and fields to update.`,
      };
    }

    if (Object.keys(updates).length === 0) {
      return {
        handled: true,
        reply:
          "Tell me what to update (title, start, end, location, or description).\nExample: update event eventId:\"abc123\" title:\"New title\"",
      };
    }

    const response = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: updates,
    });
    const event = normalizeEventResponse(response.data);
    return {
      handled: true,
      reply: `Updated event "${event.title}". eventId: ${event.eventId}`,
    };
  }

  if (/(move|reschedule)\b/.test(text) && /(event)/.test(text)) {
    const eventId = readEventId(message);
    const start = readField(message, "start");
    const end = readField(message, "end");

    if (!eventId) {
      const events = await listUpcomingEventsForChat();
      const listText = events.length
        ? `\n${events.map(formatEventForChat).join("\n")}`
        : "";
      return {
        handled: true,
        reply: `I need an eventId to reschedule an event. Here are upcoming events:${listText}\nReply with eventId, start, and end.`,
      };
    }

    if (!start || !end) {
      return {
        handled: true,
        reply:
          "To move an event, provide `start` and `end`.\nExample: move event eventId:\"abc123\" start:\"2026-05-04T10:00:00-07:00\" end:\"2026-05-04T10:30:00-07:00\"",
      };
    }

    const response = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: {
        start: { dateTime: start },
        end: { dateTime: end },
      },
    });
    const event = normalizeEventResponse(response.data);
    return {
      handled: true,
      reply: `Rescheduled event "${event.title}" to ${event.start}.`,
    };
  }

  if (/(delete|remove|cancel)\b/.test(text) && /(event)/.test(text)) {
    const eventId = readEventId(message);
    if (!eventId) {
      const events = await listUpcomingEventsForChat();
      const listText = events.length
        ? `\n${events.map(formatEventForChat).join("\n")}`
        : "";
      return {
        handled: true,
        reply: `I need an eventId before deleting an event. Here are upcoming events:${listText}`,
      };
    }

    const event = await calendar.events.get({ calendarId: "primary", eventId });
    const eventTitle = event.data.summary || eventId;
    pendingCalendarAction = {
      type: "deleteEventConfirm",
      payload: { eventId, title: eventTitle },
    };
    return {
      handled: true,
      reply: `Please confirm deletion of event "${eventTitle}" (eventId: ${eventId}). Reply with \`confirm\` to proceed or \`cancel\` to abort.`,
    };
  }

  if (/(create|add)\b/.test(text) && /calendar/.test(text)) {
    const summary = readField(message, "summary") || readField(message, "name");
    const description = readField(message, "description");
    const timeZone = readField(message, "timeZone") || readField(message, "timezone");

    if (!summary) {
      return {
        handled: true,
        reply:
          "To create a secondary calendar, provide `summary` (or `name`).\nExample: create calendar summary:\"Project X\" timeZone:\"America/Los_Angeles\"",
      };
    }

    const response = await calendar.calendars.insert({
      requestBody: {
        summary,
        description: description || undefined,
        timeZone: timeZone || undefined,
      },
    });

    return {
      handled: true,
      reply: `Created calendar "${response.data.summary}" with calendarId: ${response.data.id}`,
    };
  }

  if (/(edit|update)\b/.test(text) && /calendar/.test(text)) {
    const calendarId = readCalendarId(message);
    const summary = readField(message, "summary") || readField(message, "name");
    const description = readField(message, "description");
    const timeZone = readField(message, "timeZone") || readField(message, "timezone");

    if (!calendarId) {
      const calendars = await listCalendarsForChat();
      return {
        handled: true,
        reply: `I need a calendarId to update a calendar. Here are your calendars:\n${calendars
          .map(formatCalendarForChat)
          .join("\n")}`,
      };
    }

    const updates = {};
    if (summary !== null) updates.summary = summary;
    if (description !== null) updates.description = description;
    if (timeZone !== null) updates.timeZone = timeZone;
    if (Object.keys(updates).length === 0) {
      return {
        handled: true,
        reply: "Provide at least one field to update: summary, description, or timeZone.",
      };
    }

    const response = await calendar.calendars.patch({
      calendarId,
      requestBody: updates,
    });
    return {
      handled: true,
      reply: `Updated calendar "${response.data.summary}" (calendarId: ${response.data.id}).`,
    };
  }

  if (/(delete|remove)\b/.test(text) && /calendar/.test(text)) {
    const calendarId = readCalendarId(message);
    if (!calendarId) {
      const calendars = await listCalendarsForChat();
      return {
        handled: true,
        reply: `I need a calendarId before deleting a calendar. Here are your calendars:\n${calendars
          .map(formatCalendarForChat)
          .join("\n")}`,
      };
    }

    const meta = await calendar.calendars.get({ calendarId });
    if (meta.data?.primary) {
      return {
        handled: true,
        reply: "The primary calendar cannot be deleted. Choose a secondary calendar instead.",
      };
    }

    pendingCalendarAction = {
      type: "deleteCalendarConfirm",
      payload: {
        calendarId,
        summary: meta.data?.summary || calendarId,
      },
    };
    return {
      handled: true,
      reply: `Please confirm deletion of calendar "${meta.data?.summary || calendarId}" (calendarId: ${calendarId}). Reply with \`confirm\` to proceed or \`cancel\` to abort.`,
    };
  }

  return {
    handled: true,
    reply:
      "I can help with calendar actions like listing events/calendars, creating/updating/rescheduling events, and managing secondary calendars. Include labeled fields like `eventId`, `title`, `start`, `end`, `calendarId`, `summary`, and `timeZone` when applicable.",
  };
}

router.post("/api/reset", (req, res) => {
  resetConversationHistory();
  res.json({ success: true });
});

router.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    conversationHistory.push({ role: "user", content: message });
    trimConversationHistory();
    console.log(
      `[memory] user message added | total messages: ${conversationHistory.length}`
    );
    console.log(
      `[memory] sending full history to OpenAI | turns (excluding system): ${conversationHistory.length - 1}`
    );

    if (isCalendarReadQuery(message)) {
      const calendar = getCalendarClient();
      const reply = !calendar
        ? "Google Calendar is not connected. Click `Connect Google Calendar` first."
        : formatUpcomingEventsReply(await listUpcomingEventsForChat());

      conversationHistory.push({ role: "assistant", content: reply });
      trimConversationHistory();
      return res.json({ reply });
    }

    const calendarResult = await handleCalendarChat(message);
    if (calendarResult.handled) {
      conversationHistory.push({ role: "assistant", content: calendarResult.reply });
      trimConversationHistory();
      return res.json({ reply: calendarResult.reply });
    }

    const reply = await getOpenAIChatReply(conversationHistory);
    if (reply == null || reply === "") {
      return res.status(502).json({ error: "Assistant returned an empty response" });
    }

    conversationHistory.push({ role: "assistant", content: reply });
    trimConversationHistory();
    console.log(
      `[memory] assistant reply stored | total messages: ${conversationHistory.length}`
    );

    res.json({ reply });
  } catch (error) {
    console.error("OpenAI API error:", error);
    const status = error?.status === 401 ? 401 : 500;
    const message =
      status === 401
        ? "OpenAI API key rejected"
        : error?.message || "Failed to get assistant response";
    res.status(status).json({ error: message });
  }
});

export default router;
