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
  return (
    /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i.test(text) ||
    /\b\d{1,2}\s*(?:am|pm)\b/i.test(text)
  );
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
  const rest = m[1].trim();
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

  const resolvedTitle = title.length > 0 ? title : datePhrase ? "Meeting" : null;
  const startUtc = instantFromYmdHm(ymd, hm, timeZone);
  return {
    title: resolvedTitle,
    startUtc,
    ambiguous: !resolvedTitle || !startUtc,
  };
}

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

export {
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
};
