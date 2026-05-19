import express from "express";
import { sendToN8n } from "../services/n8nService.js";

const router = express.Router();

router.post("/api/reset", (_req, res) => res.json({ success: true }));

router.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });

  const result = await sendToN8n(message);

  if (result.error) return res.status(503).json({ error: result.error });
  res.json({ reply: result.reply });
});

export default router;
