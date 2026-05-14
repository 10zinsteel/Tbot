import {
  getCalendarClient,
  normalizeEventResponse,
  listUpcomingEventsForChat,
} from "./googleCalendarService.js";
import {
  CALENDAR_CHAT_TIME_ZONE,
  formatUpcomingEventsReply,
  formatCreatedEventChatReply,
} from "../utils/calendarParser.js";
import { registerEvent } from "../utils/eventIdStore.js";

let calendarMode = null;

function getCalendarMode() {
  return calendarMode;
}

function setCalendarMode(mode) {
  calendarMode = mode;
}

const CREATE_PROMPT = `Enter event details in this format:

Title, Date, Start Time, End Time, Location, Description

Example:
Gym, 5/15/2026, 5pm, 6pm, LA Fit, Leg day

You can leave Location and Description blank.
If End Time is blank, the event will default to 30 minutes.`;

function parseTime(timeStr) {
  timeStr = timeStr.trim().toLowerCase();
  const match12 = timeStr.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = match12[2] ? parseInt(match12[2], 10) : 0;
    if (match12[3] === "am") {
      if (hours === 12) hours = 0;
    } else {
      if (hours !== 12) hours += 12;
    }
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
  return null;
}

function parseDate(dateStr) {
  dateStr = dateStr.trim();
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    const [m, d, y] = parts;
    return `${y}-${String(parseInt(m, 10)).padStart(2, "0")}-${String(parseInt(d, 10)).padStart(2, "0")}`;
  }
  return null;
}

function addThirtyMinutes(dateTimeStr) {
  const [datePart, timePart] = dateTimeStr.split("T");
  const [h, m] = timePart.split(":").map(Number);
  const totalMinutes = h * 60 + m + 30;
  const newHours = Math.floor(totalMinutes / 60) % 24;
  const newMinutes = totalMinutes % 60;
  return `${datePart}T${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}:00`;
}

function parseCreateInput(input) {
  const parts = input.split(",").map((p) => p.trim());
  const title = parts[0] || "";
  const dateStr = parts[1] || "";
  const startTimeStr = parts[2] || "";
  const endTimeStr = parts[3] || "";
  const location = parts[4] || "";
  const description = parts.slice(5).join(",").trim();

  const missing = [];
  if (!title) missing.push("title");
  if (!dateStr) missing.push("date");
  if (!startTimeStr) missing.push("start time");
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const dateParsed = parseDate(dateStr);
  if (!dateParsed) {
    return { ok: false, error: `Could not parse date "${dateStr}". Use M/D/YYYY format, e.g. 5/15/2026.` };
  }

  const startTimeParsed = parseTime(startTimeStr);
  if (!startTimeParsed) {
    return { ok: false, error: `Could not parse start time "${startTimeStr}". Use format like 5pm or 14:30.` };
  }

  const startDateTime = `${dateParsed}T${startTimeParsed}:00`;

  let endDateTime;
  if (endTimeStr) {
    const endTimeParsed = parseTime(endTimeStr);
    if (!endTimeParsed) {
      return { ok: false, error: `Could not parse end time "${endTimeStr}". Use format like 6pm or 15:30.` };
    }
    endDateTime = `${dateParsed}T${endTimeParsed}:00`;
  } else {
    endDateTime = addThirtyMinutes(startDateTime);
  }

  return {
    ok: true,
    title,
    startDateTime,
    endDateTime,
    location: location || undefined,
    description: description || undefined,
  };
}

async function handleCalendarMenuChat(message) {
  if (!calendarMode) return { handled: false };

  if (calendarMode === "calendar_menu") {
    const choice = message.trim();

    if (choice === "1") {
      calendarMode = "calendar_create_waiting";
      return { handled: true, reply: CREATE_PROMPT };
    }
    if (choice === "2") {
      calendarMode = "calendar_edit_waiting";
      return { handled: true, reply: "Edit flow coming next. For now, use natural language editing." };
    }
    if (choice === "3") {
      calendarMode = "calendar_delete_waiting";
      return { handled: true, reply: "Delete flow coming next. For now, use natural language deletion." };
    }
    if (choice === "4") {
      const calendar = getCalendarClient();
      if (!calendar) {
        calendarMode = null;
        return { handled: true, reply: "Google Calendar is not connected." };
      }
      const events = (await listUpcomingEventsForChat()).map((e) => ({
        ...e,
        shortId: registerEvent(e.eventId),
      }));
      calendarMode = null;
      return { handled: true, reply: formatUpcomingEventsReply(events) };
    }

    return { handled: true, reply: "Please reply with 1, 2, 3, or 4." };
  }

  if (calendarMode === "calendar_create_waiting") {
    const parsed = parseCreateInput(message);

    if (!parsed.ok) {
      const errorMsg = parsed.missing
        ? `Missing required fields: ${parsed.missing.join(", ")}.`
        : parsed.error;
      return { handled: true, reply: `${errorMsg}\n\n${CREATE_PROMPT}` };
    }

    const calendar = getCalendarClient();
    if (!calendar) {
      calendarMode = null;
      return { handled: true, reply: "Google Calendar is not connected." };
    }

    try {
      const response = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: parsed.title,
          start: { dateTime: parsed.startDateTime, timeZone: CALENDAR_CHAT_TIME_ZONE },
          end: { dateTime: parsed.endDateTime, timeZone: CALENDAR_CHAT_TIME_ZONE },
          location: parsed.location,
          description: parsed.description,
        },
      });
      const event = normalizeEventResponse(response.data);
      event.shortId = registerEvent(event.eventId);
      calendarMode = null;
      return { handled: true, reply: formatCreatedEventChatReply(event) };
    } catch (err) {
      console.error("[calendar menu] Failed to create event:", err);
      calendarMode = null;
      return { handled: true, reply: "Failed to create the event. Please try again." };
    }
  }

  if (calendarMode === "calendar_edit_waiting") {
    calendarMode = null;
    return { handled: true, reply: "Edit flow coming next. For now, use natural language editing." };
  }

  if (calendarMode === "calendar_delete_waiting") {
    calendarMode = null;
    return { handled: true, reply: "Delete flow coming next. For now, use natural language deletion." };
  }

  return { handled: false };
}

export { getCalendarMode, setCalendarMode, handleCalendarMenuChat };
