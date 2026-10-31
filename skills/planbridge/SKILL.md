---
name: planbridge
description: Wire AI features (chat, summarise, classify, extract, vision/image understanding, PDF Q&A, JSON generation) into apps, scripts, sites and tools the user is building for their OWN use, powered by their local PlanBridge server (their Claude Code subscription exposed as an OpenAI/Anthropic-compatible API on localhost). Use when the user asks to "add AI", "add a chatbot", "use Claude in my app/script", "make it smart", or mentions PlanBridge — and the app runs on their own machine. For apps that other people will use or that get deployed publicly, use this skill's production path (Anthropic API key) instead.
---

# PlanBridge — give the user's own apps a Claude brain

PlanBridge is a small local server (`planbridge start`) that turns the user's Claude Code login into an API at `http://127.0.0.1:3456`:

- OpenAI-compatible: `POST /v1/chat/completions` (base URL `http://127.0.0.1:3456/v1`)
- Anthropic-compatible: `POST /v1/messages` (base URL `http://127.0.0.1:3456`)
- Browser drop-in: `<script src="http://127.0.0.1:3456/sdk.js">` → `window.PlanBridge`

## Step 0 — decide whether PlanBridge fits (always do this first)

PlanBridge is **personal use only**. Anthropic's terms do not allow a Claude subscription to serve other people.

| The app is… | Do this |
|---|---|
| A local tool, script, dashboard, desktop app or local website **only the user uses** | ✅ Use PlanBridge |
| Going to be deployed, shared, sold, or used by friends/colleagues/customers | ❌ Not PlanBridge for those users. Build it with an env-configurable base URL (below) so it runs on PlanBridge during the user's own development, and on an **Anthropic API key** in production. Tell the user this in one sentence. |

Never put a PlanBridge URL or key in code that ships to other people, and never suggest exposing PlanBridge to the internet (tunnels, ngrok, 0.0.0.0, port forwarding).

## Step 1 — check the server and get the key

```bash
curl -s http://127.0.0.1:3456/health      # {"ok":true,...} when running
planbridge key                            # prints the local API key
```

- Not running → tell the user to run `planbridge start` (or `planbridge autostart on` so it is always up). If `planbridge` itself is missing: `npm i -g planbridge` (needs Node 21.7+ and Claude Code logged in).
- Something odd → `planbridge doctor`.

Put the key in the project's `.env` (and make sure `.env` is in `.gitignore`). Never hard-code it in committed files:

```
AI_BASE_URL=http://127.0.0.1:3456/v1
AI_API_KEY=<output of planbridge key>
AI_MODEL=sonnet
```

## Step 2 — integrate with the stack's normal SDK

Prefer the **official OpenAI SDK** (or plain `fetch`) pointed at `AI_BASE_URL`. The same code then works in production by swapping env vars to Anthropic's OpenAI-compatible endpoint (`https://api.anthropic.com/v1/`, a Console API key, and a full model id such as `claude-sonnet-5-5`). Copy-paste templates for Node, Python, React/Next.js, plain HTML, and the Anthropic SDK: `references/snippets.md`.

Rules that make the result good:

1. **Call from the server side when the app has one** (API route, backend, script). Use `sdk.js` / browser `fetch` only for static local pages.
2. **Stream** anything the user will read (`stream: true`). Answers take 2–5 s to start; show a typing/loading state.
3. **Pick the model per task**: `haiku` for fast classification/extraction/short replies, `sonnet` (default) for general use, `opus` for hard reasoning or long writing. Add `reasoning_effort: "high"` only where it helps.
4. **Structured data** → `response_format: { type: "json_schema", json_schema: { name, schema } }`. The result is validated; it is also returned parsed in a top-level `parsed` field.
5. **Multi-turn chat** → either send the full `messages` history (stateless, like OpenAI) or pass `session_id: "<stable id>"` and send only the new user message (PlanBridge remembers). Use sessions for long chats.
6. **Images / PDFs / text files** → OpenAI content parts: `{type:"image_url", image_url:{url:"data:image/png;base64,..."}}` or `{type:"file", file:{filename, file_data:"data:application/pdf;base64,..."}}`. Remote `http(s)` image URLs also work.
7. **Handle errors**: connection refused → show "PlanBridge is not running — run `planbridge start`"; `429` → plan limit or local rate limit reached, show a retry message; `401` → wrong key.
8. Write a good **system prompt** for the feature (role, tone, output format, language). PlanBridge replaces Claude Code's default prompt with yours.

## What does not work (design around it)

- No function calling / `tools` (ignored). For agent-like flows, do the tool step in code and send results back as text.
- `temperature`, `top_p`, `max_tokens`, `stop` are ignored. Ask for length in the prompt.
- No image generation, embeddings, or audio endpoints.
- The thinking text is not returned (only `usage.completion_tokens_details.reasoning_tokens`).
- 2 requests run in parallel by default (more are queued), ~30/min. Batch work should be sequential or small-parallel.

Full endpoint reference: `references/api.md`.

## After integrating

Run the feature once against the live server and show the user a real response. Tell them which env vars to change if they ever deploy it for others.
