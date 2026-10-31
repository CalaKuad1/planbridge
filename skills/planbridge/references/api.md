# PlanBridge API reference

Base: `http://127.0.0.1:3456`. Auth on every `/v1/*` route: `Authorization: Bearer <key>` or `x-api-key: <key>`.

## POST /v1/chat/completions (OpenAI format)

| Field | Notes |
|---|---|
| `model` | `sonnet` (default) · `opus` · `haiku` · `fable` · or a full id `claude-…`. Other names (`gpt-4o`) map to the default model. |
| `messages` | `system` / `developer` / `user` / `assistant` / `tool`. Content: string or parts (`text`, `image_url`, `file`). |
| `stream` | SSE chunks in OpenAI format; `stream_options.include_usage` adds a usage chunk. |
| `reasoning_effort` | `low` · `medium` · `high` · `xhigh` · `max` (`minimal` → `low`). |
| `response_format` | `{type:"json_schema", json_schema:{schema}}` (validated) or `{type:"json_object"}`. |
| `session_id` | PlanBridge extension: stable id of a conversation. After the first turn send only the new user message(s). |
| `session: true` | PlanBridge extension: create a session; its id comes back as `session_id` and in the `X-Session-Id` header. |

Ignored: `temperature`, `top_p`, `max_tokens`, `stop`, `n`, `tools`, `tool_choice`, `seed`.

Response: standard `chat.completion` plus `session_id` (if any) and `parsed` (json_schema). `usage.completion_tokens_details.reasoning_tokens` counts thinking.

Content parts:
- `{type:"text", text}`
- `{type:"image_url", image_url:{url}}` with a `data:` URL or `http(s)` URL (jpeg, png, gif, webp)
- `{type:"file", file:{filename, file_data:"data:<mime>;base64,…"}}` for PDF or text-like files (txt, md, csv, json, code…)
- native Anthropic `image` / `document` blocks also accepted

## POST /v1/messages (Anthropic format)

`model`, `system` (string or blocks), `messages`, `stream`, `thinking.budget_tokens` (mapped to effort), `output_config.effort`, `output_config.format` (json_schema), `metadata.session_id`. Returns a standard Message / SSE events with a single text block.

## Other routes

| Route | |
|---|---|
| `GET /health` | no auth. `{ok, version, active, queued, default_model}` |
| `GET /v1/models` | aliases |
| `GET /v1/sessions` · `DELETE /v1/sessions/:id` | list / forget conversations |
| `GET /v1/limits` | plan usage: `rate_limit.unifiedWindows.five_hour.utilization` (0–1), `seven_day`, `resetsAt` (unix s) |
| `GET /` | playground · `GET /sdk.js` browser SDK |

## Errors

OpenAI shape `{error:{message,type,code}}` (Anthropic shape on `/v1/messages`). `400` bad request/model · `401` bad key · `413` body too large (25 MB) · `415` unsupported file · `429` plan or local rate limit · `502` Claude Code failed · `504` timeout (300 s).

## Server settings (`~/.planbridge/.env`)

`PLANBRIDGE_PORT` (3456) · `PLANBRIDGE_HOST` (127.0.0.1) · `PLANBRIDGE_API_KEY` · `DEFAULT_MODEL` · `DEFAULT_EFFORT` · `DEFAULT_SYSTEM_PROMPT` · `MAX_CONCURRENT` (2) · `MAX_QUEUE` (20) · `RATE_LIMIT_PER_MIN` (30) · `REQUEST_TIMEOUT_MS` (300000) · `MAX_BODY_MB` (25) · `CORS_ORIGIN` (*) · `CLAUDE_BIN` (claude)
