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

/** Calendar create flows interpret user date/time in this zone. */
const CALENDAR_CHAT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_EVENT_DURATION_MS = 30 * 60 * 1000;

function formatUtcOffsetForZone(utcDate, timeZone) {
  const tz =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(utcDate)
      .find((p) => p.type === "timeZoneName")?.value || "";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return "-08:00";
  const sign = m[1];
  const hh = String(m[2]).padStart(2, "0");
  const mm = String(m[3] ?? "00").padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function utcInstantToRfc3339InZone(utcDate, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcDate);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  const off = formatUtcOffsetForZone(utcDate, timeZone);
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g(
    "minute"
  )}:${g("second")}${off}`;
}

/**
 * Interprets (year, month, day, hour, minute) as wall time in `timeZone`
 * and returns the corresponding UTC instant.
 */
function zonedWallTimeToUtcDate(year, month, day, hour, minute, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function zonedAt(ms) {
    const o = {};
    for (const p of fmt.formatToParts(new Date(ms))) {
      if (p.type !== "literal") o[p.type] = p.value;
    }
    return [
      Number(o.year),
      Number(o.month),
      Number(o.day),
      Number(o.hour),
      Number(o.minute),
      Number(o.second || 0),
    ];
  }

  function cmpZ(a, t) {
    for (let i = 0; i < 5; i++) {
      if (a[i] !== t[i]) return a[i] - t[i];
    }
    return 0;
  }

  const target = [year, month, day, hour, minute];
  let lo = Date.UTC(year, month - 1, day - 2, 0, 0, 0);
  let hi = Date.UTC(year, month - 1, day + 2, 23, 59, 59);

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const z = zonedAt(mid);
    const c = cmpZ(z.slice(0, 5), target);
    if (c === 0) {
      const snapped = new Date(mid - z[5] * 1000);
      return new Date(snapped.getTime() - snapped.getUTCMilliseconds());
    }
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }

  return null;
}

function getZonedYmd(timeZone, refDate = new Date()) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(refDate)) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
  };
}

function addCivilDays(year, month, day, deltaDays) {
  const x = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: x.getUTCFullYear(),
    month: x.getUTCMonth() + 1,
    day: x.getUTCDate(),
  };
}

function resolveRelativeDayWord(word, timeZone, refDate) {
  const t = word.toLowerCase();
  const { year, month, day } = getZonedYmd(timeZone, refDate);
  if (t === "today" || t === "tonight") return { year, month, day };
  if (t === "tomorrow") return addCivilDays(year, month, day, 1);
  return null;
}

const MONTH_NAME_TO_NUM = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function parseClockTime(str) {
  const s = str.trim().toLowerCase().replace(/\./g, "");
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h > 23) return null;
    if (h < 0 || h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }
  m = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    const ap = m[2];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 0 || h > 23) return null;
    return { hour: h, minute: 0 };
  }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return { hour: h, minute: min };
  }
  return null;
}

function parseSlashDate(str, defaultYear) {
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = m[3] ? Number(m[3]) : defaultYear;
  if (m[3] && m[3].length === 2) year = 2000 + Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function parseMonthDayYearPhrase(frag, defaultYear) {
  const s = frag.trim();
  const m = s.match(
    /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\s+(\d{4}))?$/i
  );
  if (!m) return null;
  const moKey = m[1].toLowerCase();
  const month = MONTH_NAME_TO_NUM[moKey];
  if (!month) return null;
  const day = Number(m[2]);
  const year = m[3] ? Number(m[3]) : defaultYear;
  if (day < 1 || day > 31) return null;
  return { year, month, day };
}

function instantFromYmdHm(ymd, hm, timeZone) {
  if (!ymd || !hm) return null;
  return zonedWallTimeToUtcDate(
    ymd.year,
    ymd.month,
    ymd.day,
    hm.hour,
    hm.minute,
    timeZone
  );
}

function parseNaturalDateTimeTail(tail, timeZone, refDate) {
  const raw = tail.trim().replace(/\s+/g, " ");
  const lower = raw.toLowerCase();

  let m = lower.match(/^(today|tomorrow|tonight)\s+at\s+(.+)$/);
  if (m) {
    const ymd = resolveRelativeDayWord(m[1], timeZone, refDate);
    const hm = parseClockTime(m[2]);
    return instantFromYmdHm(ymd, hm, timeZone);
  }

  m = raw.match(
    /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\s+(\d{4}))?\s+at\s+(.+)$/i
  );
  if (m) {
    const moKey = m[1].toLowerCase();
    const month = MONTH_NAME_TO_NUM[moKey];
    const dayNum = Number(m[2]);
    const defaultY = getZonedYmd(timeZone, refDate).year;
    const yearNum = m[3] ? Number(m[3]) : defaultY;
    const hm = parseClockTime(m[4]);
    const ymd =
      month && dayNum >= 1 && dayNum <= 31
        ? { year: yearNum, month, day: dayNum }
        : null;
    return instantFromYmdHm(ymd, hm, timeZone);
  }

  const core = lower.startsWith("at ") ? raw.slice(3).trim() : raw;
  const tokens = core.split(/\s+/).filter(Boolean);
  const refY = getZonedYmd(timeZone, refDate).year;

  if (tokens.length === 2) {
    let hm = parseClockTime(tokens[0]);
    let ymd = parseSlashDate(tokens[1], refY);
    if (!ymd) ymd = parseMonthDayYearPhrase(tokens[1], refY);
    let inst = instantFromYmdHm(ymd, hm, timeZone);
    if (inst) return inst;

    hm = parseClockTime(tokens[1]);
    ymd = parseSlashDate(tokens[0], refY);
    if (!ymd) ymd = parseMonthDayYearPhrase(tokens[0], refY);
    inst = instantFromYmdHm(ymd, hm, timeZone);
    if (inst) return inst;
  }

  if (tokens.length >= 2) {
    const lastHm = parseClockTime(tokens[tokens.length - 1]);
    if (lastHm) {
      const dateStr = tokens.slice(0, -1).join(" ");
      let ymd = parseSlashDate(dateStr, refY);
      if (!ymd) ymd = parseMonthDayYearPhrase(dateStr, refY);
      if (!ymd) ymd = resolveRelativeDayWord(dateStr, timeZone, refDate);
      const inst = instantFromYmdHm(ymd, lastHm, timeZone);
      if (inst) return inst;
    }
    const firstHm = parseClockTime(tokens[0]);
    if (firstHm) {
      const dateStr = tokens.slice(1).join(" ");
      let ymd = parseSlashDate(dateStr, refY);
      if (!ymd) ymd = parseMonthDayYearPhrase(dateStr, refY);
      if (!ymd) ymd = resolveRelativeDayWord(dateStr, timeZone, refDate);
      const inst = instantFromYmdHm(ymd, firstHm, timeZone);
      if (inst) return inst;
    }
  }

  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractDatePartFromText(text, timeZone, refDate) {
  const refY = getZonedYmd(timeZone, refDate).year;
  const checks = [
    /\b(today|tomorrow|tonight)\b/i,
    /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i,
    /\b([a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?(?:\s+\d{4})?)\b/i,
  ];

  for (const rx of checks) {
    const match = text.match(rx);
    if (!match) continue;
    const phrase = match[1].trim();
    let ymd = resolveRelativeDayWord(phrase, timeZone, refDate);
    if (!ymd) ymd = parseSlashDate(phrase, refY);
    if (!ymd) ymd = parseMonthDayYearPhrase(phrase, refY);
    if (!ymd) continue;
    return { ymd, phrase };
  }

  return { ymd: null, phrase: null };
}

function extractTimePartFromText(text) {
  const checks = [
    /\b(?:at\s+)?(\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i,
    /\b(?:at\s+)?(\d{1,2}\s*(?:am|pm))\b/i,
  ];
  for (const rx of checks) {
    const match = text.match(rx);
    if (!match) continue;
    const phrase = match[1].trim();
    const hm = parseClockTime(phrase);
    if (hm) return { hm, phrase };
  }
  return { hm: null, phrase: null };
}

function removeExtractedPhrase(text, phrase, prepositions) {
  if (!phrase) return text;
  const pre = prepositions.length ? `(?:${prepositions.join("|")})\\s+` : "";
  const rx = new RegExp(`\\b${pre}?${escapeRegex(phrase)}\\b`, "i");
  return text.replace(rx, " ");
}

function extractNaturalTitle(message, datePhrase, timePhrase) {
  let working = message
    .replace(
      /^\s*(?:please\s+)?(?:create|add|schedule)\b(?:\s+(?:an?\s+)?(?:event|meeting|appointment))?\b/i,
      " "
    )
    .trim();

  const named = working.match(/\b(?:called|named)\b\s+(.+)$/i);
  if (named) {
    working = named[1].trim();
  } else {
    working = working.replace(/\b(?:called|named)\b/gi, " ");
  }

  working = removeExtractedPhrase(working, datePhrase, ["on", "for"]);
  working = removeExtractedPhrase(working, timePhrase, ["at"]);
  working = working.replace(/\b(on|for|at)\b/gi, " ");
  working = working.replace(/\s+/g, " ").replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
  return working || null;
}

function hasNaturalDateToken(text) {
  return (
    /\b(today|tomorrow|tonight)\b/i.test(text) ||
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(text) ||
    /\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?(?:\s+\d{4})?\b/i.test(
      text
    )
  );
}

function hasNaturalTimeToken(text) {
  return /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i.test(text) || /\b\d{1,2}\s*(?:am|pm)\b/i.test(text);
}

function looksLikeFreeformCreateEvent(message) {
  const text = message.toLowerCase();
  if (!/\b(create|add|schedule)\b/.test(text)) return false;
  if (/\breschedule\b/.test(text)) return false;
  if (/\b(event|meeting|appointment)\b/.test(text)) return true;
  return hasNaturalDateToken(message) && hasNaturalTimeToken(message);
}

const TRAILING_DATE_PATTERN =
  /\b(today|tomorrow|tonight|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?(?:\s+\d{4})?)$/i;

function stripTrailingDatePhrase(beforeAt) {
  const s = beforeAt.trim();
  const m = s.match(TRAILING_DATE_PATTERN);
  if (!m) return { title: s.trim(), datePhrase: null };
  const idx = s.lastIndexOf(m[0]);
  if (idx === -1) return { title: s.trim(), datePhrase: null };
  const title = s.slice(0, idx).trim();
  return { title, datePhrase: m[0].trim() };
}

function parseAddMeetingDetails(message, timeZone, refDate) {
  const m = message.match(/^add\s+(?:an?\s+)?meeting(?:\s+called|\s+named)?\s*(.*)$/i);
  if (!m) return null;
  let rest = m[1].trim();
  const atIdx = rest.toLowerCase().lastIndexOf(" at ");
  if (atIdx === -1) return { title: null, startUtc: null, ambiguous: true };

  const beforeAt = rest.slice(0, atIdx).trim();
  const timePart = rest.slice(atIdx + 4).trim();
  const hm = parseClockTime(timePart);
  if (!hm) return { title: null, startUtc: null, ambiguous: true };

  const { title, datePhrase } = stripTrailingDatePhrase(beforeAt);
  let ymd = null;
  if (datePhrase) {
    ymd = resolveRelativeDayWord(datePhrase, timeZone, refDate);
    const refY = getZonedYmd(timeZone, refDate).year;
    if (!ymd) ymd = parseSlashDate(datePhrase, refY);
    if (!ymd) ymd = parseMonthDayYearPhrase(datePhrase, refY);
  }

  const resolvedTitle =
    title.length > 0 ? title : datePhrase ? "Meeting" : null;
  const startUtc = instantFromYmdHm(ymd, hm, timeZone);
  return {
    title: resolvedTitle,
    startUtc,
    ambiguous: !resolvedTitle || !startUtc,
  };
}

/**
 * Try to read title + start instant from conversational create-event text.
 * Returns { title, startUtc } or partial with nulls.
 */
function parseNaturalCreateEvent(message, timeZone, refDate) {
  const t = message.trim();
  if (!looksLikeFreeformCreateEvent(t)) {
    return { title: null, startUtc: null, dateYmd: null, timeHm: null };
  }

  const { ymd, phrase: datePhrase } = extractDatePartFromText(t, timeZone, refDate);
  const { hm, phrase: timePhrase } = extractTimePartFromText(t);
  const title = extractNaturalTitle(t, datePhrase, timePhrase);
  const startUtc = instantFromYmdHm(ymd, hm, timeZone);

  if (title || startUtc || ymd || hm) {
    return { title, startUtc, dateYmd: ymd, timeHm: hm };
  }

  const meeting = parseAddMeetingDetails(t, timeZone, refDate);
  if (meeting && (meeting.title || meeting.startUtc)) {
    return {
      title: meeting.title,
      startUtc: meeting.startUtc,
      dateYmd: meeting.startUtc ? getZonedYmd(timeZone, meeting.startUtc) : null,
      timeHm: null,
    };
  }

  return { title: null, startUtc: null, dateYmd: null, timeHm: null };
}

function followUpForMissingCreateFields(title, dateYmd, timeHm, startIso) {
  if (!title) return "What should I call the event?";
  if (!startIso && !dateYmd) return "What day is this for?";
  if (!startIso && !timeHm) return "What time should it start?";
  if (!startIso) return "What day is this for?";
  return null;
}

function isReasonableDateTimeString(value) {
  if (!value || typeof value !== "string") return false;
  const d = new Date(value.trim());
  return !Number.isNaN(d.getTime());
}

function ensureEndDateTime(start, end, timeZone) {
  if (end) return end;
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return null;
  return utcInstantToRfc3339InZone(
    new Date(startDate.getTime() + DEFAULT_EVENT_DURATION_MS),
    timeZone
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

const DEFAULT_PORT = Number(process.env.PORT) || 3000;

/**
 * Start the HTTP server. Used by `node server.js` and by the Electron shell.
 * @param {number} [port=DEFAULT_PORT]
 * @returns {Promise<import("http").Server>}
 */
export function startServer(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, () => {
      console.log(`TBot server running at http://localhost:${port}`);
      console.log("[memory] short-term conversation memory initialized");
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}

function isDirectNodeRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectNodeRun()) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
