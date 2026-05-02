import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const app = express();
app.use(express.json());

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const googleOAuthClient =
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_REDIRECT_URI
    ? new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      )
    : null;

let googleTokens = null;
let pendingCalendarAction = null;

const SYSTEM_MESSAGE = {
  role: "system",
  content:
    "You are TBot, a helpful personal assistant. Be concise, practical, and friendly.",
};
const MAX_HISTORY_MESSAGES = 20;
const conversationHistory = [{ ...SYSTEM_MESSAGE }];

function trimConversationHistory() {
  const nonSystemCount = conversationHistory.length - 1;
  if (nonSystemCount > MAX_HISTORY_MESSAGES) {
    const removeCount = nonSystemCount - MAX_HISTORY_MESSAGES;
    conversationHistory.splice(1, removeCount);
    console.log(`[memory] trimmed ${removeCount} old message(s)`);
  }
}

function getCalendarClient() {
  if (!googleOAuthClient || !googleTokens) {
    return null;
  }

  googleOAuthClient.setCredentials(googleTokens);
  return google.calendar({ version: "v3", auth: googleOAuthClient });
}

function ensureGoogleCalendarConnected(req, res, next) {
  if (!googleOAuthClient || !googleTokens) {
    return res
      .status(401)
      .json({ error: "Google Calendar is not connected" });
  }

  next();
}

function normalizeEventResponse(event) {
  return {
    eventId: event.id || null,
    title: event.summary || "",
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    location: event.location || "",
    description: event.description || "",
    htmlLink: event.htmlLink || null,
  };
}

function extractCalendarEventUpdate(body) {
  const update = {};

  if (body.title !== undefined) update.summary = body.title;
  if (body.location !== undefined) update.location = body.location;
  if (body.description !== undefined) update.description = body.description;
  if (body.start !== undefined) update.start = { dateTime: body.start };
  if (body.end !== undefined) update.end = { dateTime: body.end };

  return update;
}

function isCalendarIntent(message) {
  const text = message.toLowerCase();
  if (pendingCalendarAction) return true;
  return (
    text.includes("calendar") ||
    text.includes("event") ||
    text.includes("schedule") ||
    text.includes("reschedule")
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

function formatEventForChat(event) {
  const start = event.start || "Unknown start";
  return `- ${event.title || "(No title)"} | ${start} | eventId: ${event.eventId}`;
}

function formatCalendarForChat(cal) {
  const primary = cal.primary ? " [primary]" : "";
  return `- ${cal.summary || "(No name)"}${primary} | calendarId: ${cal.calendarId}`;
}

function isCalendarReadQuery(message) {
  const text = message.toLowerCase();
  if (/(create|add|edit|update|move|reschedule|delete|remove|cancel)\b/.test(text)) {
    return false;
  }
  return [
    "my events",
    "calendar",
    "schedule",
    "what do i have",
    "upcoming",
  ].some((phrase) => text.includes(phrase));
}

function formatEventStartForUser(start) {
  if (!start) return "an unknown time";
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return start;
  return parsed.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
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

async function listUpcomingEventsForChat() {
  const calendar = getCalendarClient();
  const response = await calendar.events.list({
    calendarId: "primary",
    maxResults: 10,
    singleEvents: true,
    orderBy: "startTime",
    timeMin: new Date().toISOString(),
  });
  return (response.data.items || []).map(normalizeEventResponse);
}

async function listCalendarsForChat() {
  const calendar = getCalendarClient();
  const response = await calendar.calendarList.list();
  return (response.data.items || []).map((item) => ({
    calendarId: item.id || null,
    summary: item.summary || "",
    description: item.description || "",
    timeZone: item.timeZone || "",
    accessRole: item.accessRole || "",
    primary: !!item.primary,
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

  if (/(create|add)\b/.test(text) && /(event)/.test(text)) {
    const title = readField(message, "title");
    const start = readField(message, "start");
    const end = readField(message, "end");
    const location = readField(message, "location");
    const description = readField(message, "description");

    if (!title || !start || !end) {
      return {
        handled: true,
        reply:
          "To create an event, include `title`, `start`, and `end`.\nExample: create event title:\"Team Sync\", start:\"2026-05-03T14:00:00-07:00\", end:\"2026-05-03T14:30:00-07:00\"",
      };
    }

    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        start: { dateTime: start },
        end: { dateTime: end },
        location: location || undefined,
        description: description || undefined,
      },
    });

    const event = normalizeEventResponse(response.data);
    return {
      handled: true,
      reply: `Created event "${event.title}" (${event.start} -> ${event.end}). eventId: ${event.eventId}`,
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

// Serve the TBot UI (HTML, CSS, JS) from the project root so /api/chat stays same-origin
app.use(express.static(__dirname));

app.get("/auth/google", (req, res) => {
  if (!googleOAuthClient) {
    return res.status(500).json({
      error:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
    });
  }

  const authUrl = googleOAuthClient.generateAuthUrl({
    access_type: "offline",
    scope: [GOOGLE_CALENDAR_SCOPE],
    prompt: "consent",
  });

  res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!googleOAuthClient) {
      return res.status(500).json({
        error:
          "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
      });
    }

    const { code } = req.query;
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "Missing OAuth code" });
    }

    const { tokens } = await googleOAuthClient.getToken(code);
    googleOAuthClient.setCredentials(tokens);
    googleTokens = tokens;

    console.log("[google-oauth] Google account connected successfully");
    res.redirect("/");
  } catch (error) {
    console.error("[google-oauth] Callback error:", error);
    res.status(500).json({ error: "Failed to connect Google account" });
  }
});

app.post("/api/reset", (req, res) => {
  conversationHistory.length = 0;
  conversationHistory.push({ ...SYSTEM_MESSAGE });
  console.log("[memory] conversation reset to system message");
  res.json({ success: true });
});

app.get("/api/calendar/events", ensureGoogleCalendarConnected, async (req, res) => {
  try {
    const calendar = getCalendarClient();
    if (!calendar) {
      return res
        .status(401)
        .json({ error: "Google Calendar is not connected" });
    }

    const response = await calendar.events.list({
      calendarId: "primary",
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: new Date().toISOString(),
    });

    const events = (response.data.items || []).map(normalizeEventResponse);
    res.json({ events });
  } catch (error) {
    console.error("[calendar] Failed to fetch events:", error);
    res.status(500).json({ error: "Failed to fetch calendar events" });
  }
});

app.post("/api/calendar/events", ensureGoogleCalendarConnected, async (req, res) => {
  try {
    const { title, start, end, location, description } = req.body;
    if (!title || !start || !end) {
      return res
        .status(400)
        .json({ error: "title, start, and end are required" });
    }

    const calendar = getCalendarClient();
    if (!calendar) {
      return res
        .status(401)
        .json({ error: "Google Calendar is not connected" });
    }

    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        start: { dateTime: start },
        end: { dateTime: end },
        location,
        description,
      },
    });

    res.status(201).json({ event: normalizeEventResponse(response.data) });
  } catch (error) {
    console.error("[calendar] Failed to create event:", error);
    res.status(500).json({ error: "Failed to create calendar event" });
  }
});

app.patch(
  "/api/calendar/events/:eventId",
  ensureGoogleCalendarConnected,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      if (!eventId) {
        return res.status(400).json({ error: "eventId is required" });
      }

      const update = extractCalendarEventUpdate(req.body);
      if (Object.keys(update).length === 0) {
        return res.status(400).json({
          error:
            "At least one of title, start, end, location, description is required",
        });
      }

      const calendar = getCalendarClient();
      if (!calendar) {
        return res
          .status(401)
          .json({ error: "Google Calendar is not connected" });
      }

      const response = await calendar.events.patch({
        calendarId: "primary",
        eventId,
        requestBody: update,
      });

      res.json({ event: normalizeEventResponse(response.data) });
    } catch (error) {
      console.error("[calendar] Failed to update event:", error);
      if (error?.code === 404) {
        return res.status(404).json({ error: "Calendar event not found" });
      }
      res.status(500).json({ error: "Failed to update calendar event" });
    }
  }
);

app.patch(
  "/api/calendar/events/:eventId/move",
  ensureGoogleCalendarConnected,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const { start, end } = req.body;
      if (!eventId) {
        return res.status(400).json({ error: "eventId is required" });
      }
      if (!start || !end) {
        return res.status(400).json({ error: "start and end are required" });
      }

      const calendar = getCalendarClient();
      if (!calendar) {
        return res
          .status(401)
          .json({ error: "Google Calendar is not connected" });
      }

      const response = await calendar.events.patch({
        calendarId: "primary",
        eventId,
        requestBody: {
          start: { dateTime: start },
          end: { dateTime: end },
        },
      });

      res.json({ event: normalizeEventResponse(response.data) });
    } catch (error) {
      console.error("[calendar] Failed to move event:", error);
      if (error?.code === 404) {
        return res.status(404).json({ error: "Calendar event not found" });
      }
      res.status(500).json({ error: "Failed to reschedule calendar event" });
    }
  }
);

app.delete(
  "/api/calendar/events/:eventId",
  ensureGoogleCalendarConnected,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      if (!eventId) {
        return res.status(400).json({ error: "eventId is required" });
      }

      const calendar = getCalendarClient();
      if (!calendar) {
        return res
          .status(401)
          .json({ error: "Google Calendar is not connected" });
      }

      await calendar.events.delete({
        calendarId: "primary",
        eventId,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("[calendar] Failed to delete event:", error);
      if (error?.code === 404) {
        return res.status(404).json({ error: "Calendar event not found" });
      }
      res.status(500).json({ error: "Failed to delete calendar event" });
    }
  }
);

app.get(
  "/api/calendar/calendars",
  ensureGoogleCalendarConnected,
  async (req, res) => {
    try {
      const calendar = getCalendarClient();
      if (!calendar) {
        return res
          .status(401)
          .json({ error: "Google Calendar is not connected" });
      }

      const response = await calendar.calendarList.list();
      const calendars = (response.data.items || []).map((item) => ({
        calendarId: item.id || null,
        summary: item.summary || "",
        description: item.description || "",
        timeZone: item.timeZone || "",
        accessRole: item.accessRole || "",
        primary: !!item.primary,
      }));

      res.json({ calendars });
    } catch (error) {
      console.error("[calendar] Failed to list calendars:", error);
      res.status(500).json({ error: "Failed to list calendars" });
    }
  }
);

app.post(
  "/api/calendar/calendars",
  ensureGoogleCalendarConnected,
  async (req, res) => {
    try {
      const { summary, description, timeZone } = req.body;
      if (!summary) {
        return res.status(400).json({ error: "summary is required" });
      }

      const calendar = getCalendarClient();
      if (!calendar) {
        return res
          .status(401)
          .json({ error: "Google Calendar is not connected" });
      }

      const response = await calendar.calendars.insert({
        requestBody: {
          summary,
          description,
          timeZone,
        },
      });

      res.status(201).json({
        calendar: {
          calendarId: response.data.id || null,
          summary: response.data.summary || "",
          description: response.data.description || "",
          timeZone: response.data.timeZone || "",
        },
      });
    } catch (error) {
      console.error("[calendar] Failed to create calendar:", error);
      res.status(500).json({ error: "Failed to create calendar" });
    }
  }
);

app.patch(
  "/api/calendar/calendars/:calendarId",
  ensureGoogleCalendarConnected,
  async (req, res) => {
    try {
      const { calendarId } = req.params;
      const { summary, description, timeZone } = req.body;
      if (!calendarId) {
        return res.status(400).json({ error: "calendarId is required" });
      }

      const updates = {};
      if (summary !== undefined) updates.summary = summary;
      if (description !== undefined) updates.description = description;
      if (timeZone !== undefined) updates.timeZone = timeZone;

      if (Object.keys(updates).length === 0) {
        return res
          .status(400)
          .json({ error: "At least one of summary, description, timeZone is required" });
      }

      const calendar = getCalendarClient();
      if (!calendar) {
        return res
          .status(401)
          .json({ error: "Google Calendar is not connected" });
      }

      const response = await calendar.calendars.patch({
        calendarId,
        requestBody: updates,
      });

      res.json({
        calendar: {
          calendarId: response.data.id || null,
          summary: response.data.summary || "",
          description: response.data.description || "",
          timeZone: response.data.timeZone || "",
        },
      });
    } catch (error) {
      console.error("[calendar] Failed to update calendar:", error);
      if (error?.code === 404) {
        return res.status(404).json({ error: "Calendar not found" });
      }
      res.status(500).json({ error: "Failed to update calendar" });
    }
  }
);

app.delete(
  "/api/calendar/calendars/:calendarId",
  ensureGoogleCalendarConnected,
  async (req, res) => {
    try {
      const { calendarId } = req.params;
      if (!calendarId) {
        return res.status(400).json({ error: "calendarId is required" });
      }

      const calendar = getCalendarClient();
      if (!calendar) {
        return res
          .status(401)
          .json({ error: "Google Calendar is not connected" });
      }

      const meta = await calendar.calendars.get({ calendarId });
      if (meta.data?.primary) {
        return res
          .status(400)
          .json({ error: "Primary calendar cannot be deleted" });
      }

      await calendar.calendars.delete({ calendarId });
      res.json({ success: true });
    } catch (error) {
      console.error("[calendar] Failed to delete calendar:", error);
      if (error?.code === 404) {
        return res.status(404).json({ error: "Calendar not found" });
      }
      res.status(500).json({ error: "Failed to delete calendar" });
    }
  }
);

app.post("/api/chat", async (req, res) => {
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

    if (!client || !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: conversationHistory.map((entry) => ({
        role: entry.role,
        content: entry.content,
      })),
    });

    const reply = response.output_text;
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
        : "Failed to get assistant response";
    res.status(status).json({ error: message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TBot server running at http://localhost:${PORT}`);
  console.log("[memory] short-term conversation memory initialized");
});
