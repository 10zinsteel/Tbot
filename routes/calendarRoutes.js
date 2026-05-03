import express from "express";
import {
  ensureGoogleCalendarConnected,
  getCalendarClient,
  normalizeEventResponse,
  extractCalendarEventUpdate,
} from "../services/googleCalendarService.js";
import { CALENDAR_CHAT_TIME_ZONE } from "../utils/calendarParser.js";

const router = express.Router();

router.get("/api/calendar/events", ensureGoogleCalendarConnected, async (req, res) => {
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

router.post("/api/calendar/events", ensureGoogleCalendarConnected, async (req, res) => {
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
        start: { dateTime: start, timeZone: CALENDAR_CHAT_TIME_ZONE },
        end: { dateTime: end, timeZone: CALENDAR_CHAT_TIME_ZONE },
        location,
        description,
      },
    });

    console.log(
      "[calendar] API POST events.insert full response:",
      JSON.stringify(response.data, null, 2)
    );

    res.status(201).json({ event: normalizeEventResponse(response.data) });
  } catch (error) {
    console.error("[calendar] Failed to create event:", error);
    res.status(500).json({ error: "Failed to create calendar event" });
  }
});

router.patch(
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

router.patch(
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

router.delete(
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

router.get(
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

router.post(
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

router.patch(
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

router.delete(
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

export default router;
