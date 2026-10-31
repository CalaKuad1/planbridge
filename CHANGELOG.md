# Changelog

## 1.1.0

- Warm process pool: pre-starts the Claude Code process the next request will need (same settings, or the next turn of a session). Median first token 2.49 s → 1.50 s (stateless) and 2.44 s → 1.68 s (sessions). `WARM_POOL`, `WARM_TTL_MS`; pool stats in `/health`.
- Skill: patterns for app-side memory, search results and agent loops via structured output.
- Roadmap simplified: PlanBridge stays a plain model API.

## 1.0.0

- OpenAI-compatible `POST /v1/chat/completions` (streaming, images, PDFs, text files, JSON schema, reasoning effort)
- Anthropic-compatible `POST /v1/messages` (streaming)
- Server-side conversations with `session_id`
- Browser SDK at `/sdk.js` and a built-in playground
- Plan usage at `/v1/limits` and in `planbridge status`
- CLI: start, stop, status, open, key, env, doctor, skill, autostart
- Claude Code skill + plugin marketplace manifest
- One-line installers for macOS, Linux and Windows
