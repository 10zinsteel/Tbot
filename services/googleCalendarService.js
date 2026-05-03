import { google } from "googleapis";

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

function getGoogleAuthUrl() {
  if (!googleOAuthClient) {
    return null;
  }
  return googleOAuthClient.generateAuthUrl({
    access_type: "offline",
    scope: [GOOGLE_CALENDAR_SCOPE],
    prompt: "consent",
  });
}

async function handleGoogleOAuthCallback(code) {
  const { tokens } = await googleOAuthClient.getToken(code);
  googleOAuthClient.setCredentials(tokens);
  googleTokens = tokens;
}

function isGoogleOAuthConfigured() {
  return !!googleOAuthClient;
}

export {
  getCalendarClient,
  ensureGoogleCalendarConnected,
  normalizeEventResponse,
  extractCalendarEventUpdate,
  listUpcomingEventsForChat,
  listCalendarsForChat,
  getGoogleAuthUrl,
  handleGoogleOAuthCallback,
  isGoogleOAuthConfigured,
};
