// TBot sends messages to n8n.
// n8n handles workflow routing, AI decisions, and external app actions.
// TBot only displays the returned reply.

export async function sendToN8n(message) {
  // Read at call time so dotenv has already populated process.env
  const webhookUrl = process.env.N8N_WEBHOOK_URL;

  if (!webhookUrl) {
    return {
      error:
        "n8n webhook is not configured. Add N8N_WEBHOOK_URL to your .env file.",
    };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, source: "tbot" }),
    });

    if (!res.ok) return { error: "Could not reach the n8n workflow." };

    const data = await res.json();
    if (!data?.reply) return { error: "Could not reach the n8n workflow." };

    return { reply: data.reply };
  } catch {
    return { error: "Could not reach the n8n workflow." };
  }
}
