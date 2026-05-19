# TBot × n8n Integration

## Architecture

```
User types message
      │
      ▼
TBot UI (index.html / script.js)
      │  POST { message }
      ▼
Express /api/chat  (server.js → routes/chatRoutes.js)
      │  POST { message, source: "tbot" }
      ▼
n8n Webhook  (https://tenzinsteel.app.n8n.cloud/webhook/tbot-chat)
      │
      ▼
OpenAI: Classify Intent
      │
      ▼
Switch → general_chat ──► OpenAI: Chat Reply ──► Respond { reply }
       → calendar_create ──────────────────────► Respond { reply }
       → calendar_list ───────────────────────► Respond { reply }
       → calendar_update ─────────────────────► Respond { reply }
       → calendar_delete ─────────────────────► Respond { reply }
       → unknown (fallback) ─────────────────► Respond { reply }
      │
      ▼
Express receives { reply }
      │
      ▼
TBot UI displays reply in chat
```

**TBot's role:** thin UI shell — sends every message to n8n and shows whatever reply comes back.  
**n8n's role:** all intelligence — intent classification, AI responses, and future external integrations.

---

## How TBot Communicates with n8n

### Request (TBot → n8n)
```
POST https://tenzinsteel.app.n8n.cloud/webhook/tbot-chat
Content-Type: application/json

{
  "message": "what's on my calendar tomorrow?",
  "source":  "tbot"
}
```

### Response (n8n → TBot)
```json
{ "reply": "Here are your events for tomorrow..." }
```

If n8n is unreachable or the webhook URL is missing, [services/n8nService.js](services/n8nService.js) returns a graceful error message to the chat.

---

## Starting TBot + n8n

n8n is already running in the cloud — no local start needed.

```bash
# Start TBot server only
npm start

# Start TBot Electron desktop app
npm run desktop
```

**n8n cloud instance:** https://tenzinsteel.app.n8n.cloud  
**Workflow name:** TBot Intent Router (ID: `ij45SdZYowxLClkR`)  
**Status:** Active ✓

---

## Environment Variables

| Variable | Value | Purpose |
|---|---|---|
| `N8N_WEBHOOK_URL` | `https://tenzinsteel.app.n8n.cloud/webhook/tbot-chat` | n8n webhook endpoint |
| `OPENAI_API_KEY` | `sk-proj-...` | Used locally (kept for legacy services) |

The OpenAI API key is also stored as a credential inside n8n ("OpenAI account", ID: `2HfjpYvQNgmnPtqr`).

---

## Intent Classification

The "Classify Intent" node sends the user message to `gpt-4o-mini` with this system prompt:

> Classify the user message into exactly one of: general_chat, calendar_create, calendar_list, calendar_update, calendar_delete, unknown. Reply with only the label, no punctuation, no explanation.

| Intent | Example message | Branch |
|---|---|---|
| `general_chat` | "what's the weather like?" | → OpenAI chat reply |
| `calendar_create` | "add a meeting Thursday at 2pm" | → placeholder (v2: real calendar) |
| `calendar_list` | "what's on my calendar this week?" | → placeholder (v2: real calendar) |
| `calendar_update` | "move my 3pm to 4pm" | → placeholder (v2: real calendar) |
| `calendar_delete` | "cancel tomorrow's dentist" | → placeholder (v2: real calendar) |
| `unknown` | anything else | → "I'm not sure what you mean" |

---

## Workflow File

The workflow is exported to [n8n-workflows/tbot-intent-router.json](n8n-workflows/tbot-intent-router.json).

**To re-import after a reset:**
1. Open https://tenzinsteel.app.n8n.cloud
2. Workflows → Import from file → select `n8n-workflows/tbot-intent-router.json`
3. Open the two OpenAI nodes and re-link the "OpenAI account" credential
4. Activate the workflow
5. Copy the Production webhook URL back into `.env` as `N8N_WEBHOOK_URL`

---

## OpenAI Credentials in n8n

The existing "OpenAI account" credential (type: `openAiApi`) is already linked to both OpenAI nodes. If you need to update the key:

1. n8n UI → Credentials → "OpenAI account" → Edit
2. Paste the new API key
3. Save — all linked nodes update automatically

---

## Webhook Testing

```bash
# Test the live webhook directly
curl -X POST https://tenzinsteel.app.n8n.cloud/webhook/tbot-chat \
  -H "Content-Type: application/json" \
  -d '{"message": "hello there", "source": "tbot"}'

# Expected response
{"reply":"Hello! How can I help you today?"}

# Test calendar intent routing
curl -X POST https://tenzinsteel.app.n8n.cloud/webhook/tbot-chat \
  -H "Content-Type: application/json" \
  -d '{"message": "add a dentist appointment tomorrow at 3pm", "source": "tbot"}'

# Expected response
{"reply":"I can see you want to create a calendar event. Full calendar integration is coming soon in TBot!"}
```

---

## Extending Workflows

### Adding a new intent (e.g., email)

1. Open the "TBot Intent Router" workflow in n8n
2. Update the "Classify Intent" system prompt to include `email_send` in the label list
3. Add a new rule to the "Route by Intent" Switch node for `email_send`
4. Connect it to a new branch (Gmail node → Respond to Webhook)
5. No changes needed in TBot's Express code

### Where future integrations should live

| Capability | n8n nodes to use |
|---|---|
| Google Calendar (real) | Google Calendar node + OAuth credential |
| Gmail | Gmail node (credential already exists: "Gmail OAuth2 API") |
| CRM (e.g. HubSpot) | HTTP Request node → HubSpot API |
| Reminders / scheduled tasks | Schedule Trigger + n8n sub-workflows |
| Memory / conversation history | n8n data tables or Pinecone vector store |

### Replacing a calendar placeholder with real integration

1. Delete the "Respond Calendar Create" node
2. Add a Google Calendar → Create Event node
3. Add a Code node to format the reply: `return [{ json: { reply: 'Event created: ' + $json.summary } }]`
4. Add a Respond to Webhook node that returns `{ reply: $json.reply }`
5. Connect: Switch (calendar_create) → Google Calendar → Code → Respond
6. Zero changes needed in TBot

---

## File Map

| File | Role |
|---|---|
| [services/n8nService.js](services/n8nService.js) | Sends message to n8n, returns reply |
| [routes/chatRoutes.js](routes/chatRoutes.js) | Express route — delegates entirely to n8nService |
| [.env](.env) | Contains `N8N_WEBHOOK_URL` |
| [n8n-workflows/tbot-intent-router.json](n8n-workflows/tbot-intent-router.json) | Workflow export for backup/re-import |
| [services/openaiService.js](services/openaiService.js) | Legacy — not used by /api/chat anymore |
| [services/calendarChatService.js](services/calendarChatService.js) | Legacy — not used by /api/chat anymore |
