# Changelog

## 1.2.0

- **Integration tests against a fake Claude Code CLI** (`test/fixtures/fake-claude.mjs`): 35 tests covering both API formats, streaming, sessions, files, errors, timeouts, limits, disconnects and the warm pool, in ~6 s on every OS in CI.
- **Weekly Claude Code compatibility workflow**: installs the latest CLI and checks every argument set PlanBridge uses (`scripts/check-cli-compat.mjs`).
- `planbridge doctor` warns when your Claude Code version differs from the tested one; `doctor --deep` sends one real request through the pipeline. It also detects the skill when installed as a plugin.
- Errors use the CLI's `api_error_status` instead of guessing from the message: 404 unknown model, 503 overloaded, and 401/403 from Claude Code's own login now map to 502.
- Fix: in streaming mode, errors before the first token returned `200` with an error chunk. They now return the real HTTP status (e.g. 429).
- Conversations idle for `SESSION_TTL_DAYS` (30) are deleted automatically. `DELETE /v1/sessions/:id` also removes the Claude Code transcript.
- Fix: warm processes could be started after shutdown.
- Fix (Windows): Claude Code installed with `npm i -g @anthropic-ai/claude-code` (a `claude.cmd` shim) could not be started. PlanBridge now runs the binary the shim points to.
- `CLAUDE_BIN` can point to a `.js`/`.mjs` script.
- Smoke test in English, and it now checks the answers.
- Cleaner `start --log` output with timestamps.

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
