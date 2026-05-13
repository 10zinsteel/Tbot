import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

async function getOpenAIChatReply(history) {
  if (!client) {
    const err = new Error("Missing OPENAI_API_KEY");
    err.status = 500;
    throw err;
  }

  const response = await client.responses.create({
    model: OPENAI_MODEL,
    input: history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
  });

  return response.output_text;
}

const CALENDAR_EXTRACTION_SYSTEM = `You extract calendar intent from user messages. Respond with ONLY a valid JSON object — no explanation, no markdown, no code blocks.

Return this exact schema:
{
  "intent": one of: "create_event" | "update_event" | "move_event" | "delete_event" | "list_events" | "list_calendars" | "create_calendar" | "update_calendar" | "delete_calendar" | "unknown",
  "title": string or null,
  "start": RFC3339 datetime or null,
  "end": RFC3339 datetime or null,
  "location": string or null,
  "description": string or null,
  "eventId": string or null,
  "calendarId": string or null,
  "summary": string or null,
  "timeZone": string or null
}

Rules:
- Resolve relative dates (today, tomorrow, next Friday) to RFC3339 using the provided current date/time and timezone.
- RFC3339 format: YYYY-MM-DDTHH:mm:ss±HH:MM  (example: "2026-05-14T19:00:00-07:00")
- Use the provided timezone for all datetime values unless the user specifies a different one.
- "title" is for event names. "summary" is for calendar names.
- If no time is mentioned, set start to null.
- For list_events and list_calendars intents, set all fields except intent to null.
- If the message is not a calendar request, return intent "unknown" with all other fields null.
- Output ONLY the JSON object.`;

async function extractCalendarIntent(message, timeZone, now) {
  if (!client) return { intent: "unknown" };

  const localDate = now.toLocaleDateString("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const localTime = now.toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  try {
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: CALENDAR_EXTRACTION_SYSTEM },
        {
          role: "user",
          content: `Current date/time: ${localDate}, ${localTime}\n\nUser message: "${message}"`,
        },
      ],
    });

    const raw = (response.output_text || "").trim();
    const parsed = parseJsonSafe(raw);

    if (!parsed || typeof parsed.intent !== "string") {
      return { intent: "unknown" };
    }

    console.log(`[calendar] extracted intent: ${parsed.intent}`);

    return {
      intent: parsed.intent,
      title: parsed.title || null,
      start: parsed.start || null,
      end: parsed.end || null,
      location: parsed.location || null,
      description: parsed.description || null,
      eventId: parsed.eventId || null,
      calendarId: parsed.calendarId || null,
      summary: parsed.summary || null,
      timeZone: parsed.timeZone || null,
    };
  } catch {
    return { intent: "unknown" };
  }
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Handle model wrapping JSON in markdown code blocks or adding preamble
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export { getOpenAIChatReply, extractCalendarIntent };
