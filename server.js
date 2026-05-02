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

    if (!client || !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

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
