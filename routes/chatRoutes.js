import express from "express";
import { getOpenAIChatReply } from "../services/openaiService.js";
import {
  conversationHistory,
  trimConversationHistory,
  resetConversationHistory,
} from "../services/memoryService.js";
import { handleCalendarChat } from "../services/calendarChatService.js";
import { handleCalendarMenuChat } from "../services/calendarMenuService.js";

const router = express.Router();

router.post("/api/reset", (req, res) => {
  resetConversationHistory();
  res.json({ success: true });
});

router.post("/api/chat", async (req, res) => {
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

    const menuResult = await handleCalendarMenuChat(message);
    if (menuResult.handled) {
      conversationHistory.push({ role: "assistant", content: menuResult.reply });
      trimConversationHistory();
      return res.json({ reply: menuResult.reply });
    }

    const calendarResult = await handleCalendarChat(message);
    if (calendarResult.handled) {
      conversationHistory.push({ role: "assistant", content: calendarResult.reply });
      trimConversationHistory();
      return res.json({ reply: calendarResult.reply });
    }

    const reply = await getOpenAIChatReply(conversationHistory);
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
        : error?.message || "Failed to get assistant response";
    res.status(status).json({ error: message });
  }
});

export default router;
