import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

// Load OPENAI_API_KEY and other secrets from .env (never commit .env)
dotenv.config();

const app = express();
app.use(express.json());

/**
 * Official OpenAI client: only constructed when OPENAI_API_KEY is set.
 * The SDK throws if instantiated without a key, so we skip creation until configured.
 * The key never touches the browser — only this server calls OpenAI.
 */
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Default model for the Responses API (override with OPENAI_MODEL in .env if needed).
 */
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!client || !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    /**
     * Responses API: sends the user turn plus system-style instructions.
     * `output_text` is the aggregated assistant text for non-streaming calls.
     */
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: message,
      instructions:
        "You are TBot, a helpful personal assistant. Be concise, practical, and friendly.",
    });

    const reply = response.output_text;
    if (reply == null || reply === "") {
      return res.status(502).json({ error: "Assistant returned an empty response" });
    }

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

export default app;
