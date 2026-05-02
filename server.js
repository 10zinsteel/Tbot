import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const app = express();
app.use(express.json());

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

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

// Serve the TBot UI (HTML, CSS, JS) from the project root so /api/chat stays same-origin
app.use(express.static(__dirname));

app.post("/api/reset", (req, res) => {
  conversationHistory.length = 0;
  conversationHistory.push({ ...SYSTEM_MESSAGE });
  console.log("[memory] conversation reset to system message");
  res.json({ success: true });
});

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
