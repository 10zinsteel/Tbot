import OpenAI from "openai";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

async function getOpenAIChatReply(history) {
  if (!client || !process.env.OPENAI_API_KEY) {
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

export { getOpenAIChatReply };
