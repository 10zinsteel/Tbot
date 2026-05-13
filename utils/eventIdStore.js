// In-memory bidirectional mapping between 6-digit short IDs and real Google Calendar event IDs.
// Short IDs are ephemeral — they reset when the server restarts.

const shortToReal = new Map(); // shortId (string "NNNNNN") -> googleEventId
const realToShort = new Map(); // googleEventId -> shortId

function generateShortId() {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (shortToReal.has(id));
  return id;
}

/**
 * Returns the existing short ID for a Google event ID, or creates and stores a new one.
 */
function registerEvent(googleEventId) {
  if (!googleEventId) return null;
  if (realToShort.has(googleEventId)) return realToShort.get(googleEventId);
  const shortId = generateShortId();
  shortToReal.set(shortId, googleEventId);
  realToShort.set(googleEventId, shortId);
  return shortId;
}

/**
 * Removes a Google event ID and its short ID from the store (frees the slot for reuse).
 */
function releaseEvent(googleEventId) {
  if (!googleEventId) return;
  const shortId = realToShort.get(googleEventId);
  if (shortId) {
    shortToReal.delete(shortId);
    realToShort.delete(googleEventId);
  }
}

/**
 * Resolves a 6-digit short ID to its real Google event ID.
 * Returns null if not found.
 */
function resolveShortId(shortId) {
  return shortToReal.get(shortId) ?? null;
}

/**
 * Returns the short ID for a real Google event ID, or null if not registered.
 */
function getShortId(googleEventId) {
  return realToShort.get(googleEventId) ?? null;
}

export { registerEvent, releaseEvent, resolveShortId, getShortId };
