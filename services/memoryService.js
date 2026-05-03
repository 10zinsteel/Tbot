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

function resetConversationHistory() {
  conversationHistory.length = 0;
  conversationHistory.push({ ...SYSTEM_MESSAGE });
  console.log("[memory] conversation reset to system message");
}

export {
  SYSTEM_MESSAGE,
  conversationHistory,
  trimConversationHistory,
  resetConversationHistory,
};
