// Runs the official, unmodified Claude Code CLI in headless mode and turns its
// stream-json output into a few simple events. Keeps a small pool of pre-started
// ("warm") processes so the next request skips the CLI start-up time.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { httpError } from './params.js';

/** Latest plan-usage info reported by the CLI (5h / 7d windows). */
export let lastRateLimit = null;

// ---------------------------------------------------------------------------
// Process spec + spawning
// ---------------------------------------------------------------------------

/** Everything that decides the CLI arguments. Requests with the same key can share a warm process. */
function specOf(opts) {
  const s = opts.session || { mode: 'none' };
  const spec = {
    model: opts.model,
    effort: opts.effort || '',
    systemPrompt: opts.systemPrompt || '',
    jsonSchema: opts.jsonSchema || null,
    session: { mode: s.mode, id: s.mode === 'none' ? null : s.id },
  };
  spec.key = JSON.stringify([spec.model, spec.effort, spec.systemPrompt, spec.jsonSchema, spec.session.mode, spec.session.id]);
  return spec;
}

function argsOf(spec, promptFile) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '', //               no tools: behaves like a plain chat model
    '--safe-mode', //               ignore the user's hooks, plugins, MCP servers, CLAUDE.md…
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--permission-prompts', 'none',
    '--model', spec.model,
  ];
  if (spec.effort) args.push('--effort', spec.effort);
  if (promptFile) args.push('--system-prompt-file', promptFile);
  if (spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.session.mode === 'new') args.push('--session-id', spec.session.id);
  else if (spec.session.mode === 'resume') args.push('--resume', spec.session.id);
  else args.push('--no-session-persistence');
  return args;
}

/** Starts a CLI process. It waits on stdin until it gets the user message. */
function spawnProc(spec) {
  let promptFile = null;
  if (spec.systemPrompt) {
    // a file avoids command-line length/quoting limits (Windows: 32k chars)
    promptFile = path.join(config.tmpDir, `sp-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(promptFile, spec.systemPrompt);
  }
  const [cmd, pre] = claudeCommand();
  const child = spawn(cmd, [...pre, ...argsOf(spec, promptFile)], {
    cwd: config.workspaceDir,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const proc = { spec, child, exited: false, spawnError: null, stderr: '', lines: [], onLine: null, onExit: null, bornAt: Date.now() };
  let buf = '';
  const emit = (line) => (proc.onLine ? proc.onLine(line) : proc.lines.push(line));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) emit(line);
    }
  });
  child.stderr.on('data', (d) => (proc.stderr += d));
  child.stdin.on('error', () => {});
  child.on('error', (e) => (proc.spawnError = e));
  child.on('close', (code) => {
    if (buf.trim()) emit(buf.trim());
    proc.exited = true;
    if (promptFile) fs.rm(promptFile, { force: true }, () => {});
    pool.forget(proc);
    proc.onExit?.(code);
  });
  live.add(child);
  child.on('close', () => live.delete(child));
  return proc;
}

// ---------------------------------------------------------------------------
// Warm pool
// ---------------------------------------------------------------------------

const live = new Set(); // every child we started, so none outlive the server
const pool = {
  idle: [], // [{proc, timer}]
  stopped: false,
  stats: { warmHits: 0, coldStarts: 0 },

  take(key) {
    const i = this.idle.findIndex((e) => e.proc.spec.key === key && !e.proc.exited && !e.proc.spawnError);
    if (i < 0) return null;
    const [e] = this.idle.splice(i, 1);
    clearTimeout(e.timer);
    return e.proc;
  },

  /** Start a process now for a request we expect soon. */
  prewarm(spec) {
    if (config.warmPool <= 0 || this.stopped) return;
    // a session may only have one warm process, and only the latest spec for it
    this.idle
      .filter((e) => e.proc.spec.key === spec.key || (spec.session.id && e.proc.spec.session.id === spec.session.id))
      .forEach((e) => this.discard(e));
    while (this.idle.length >= config.warmPool) this.discard(this.idle[0]); // evict oldest
    const proc = spawnProc(spec);
    const entry = { proc, timer: setTimeout(() => this.discard(entry), config.warmTtlMs) };
    entry.timer.unref?.();
    this.idle.push(entry);
  },

  discard(entry) {
    clearTimeout(entry.timer);
    const i = this.idle.indexOf(entry);
    if (i >= 0) this.idle.splice(i, 1);
    if (!entry.proc.exited) entry.proc.child.kill();
  },

  forget(proc) {
    const i = this.idle.findIndex((e) => e.proc === proc);
    if (i >= 0) {
      clearTimeout(this.idle[i].timer);
      this.idle.splice(i, 1);
    }
  },

  /** Drop warm processes of a conversation (e.g. when it is deleted). */
  dropSession(claudeSessionId) {
    this.idle.filter((e) => e.proc.spec.session.id === claudeSessionId).forEach((e) => this.discard(e));
  },

  info() {
    return { size: this.idle.length, max: config.warmPool, ...this.stats };
  },
};
export { pool };

/** Kills every CLI process we started (warm or busy). */
export function shutdown() {
  pool.stopped = true;
  for (const e of [...pool.idle]) clearTimeout(e.timer);
  pool.idle.length = 0;
  for (const c of live) {
    try {
      c.kill();
    } catch {}
  }
}
process.on('exit', shutdown);

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {Array}  opts.content       Anthropic-style content blocks for the user turn
 * @param {string} opts.model
 * @param {string} [opts.effort]
 * @param {string} [opts.systemPrompt]
 * @param {object} [opts.jsonSchema]
 * @param {{mode:'none'|'new'|'resume', id?:string}} [opts.session]
 * @param {AbortSignal} [opts.signal]
 * @returns {EventEmitter} 'init' {model, sessionId} · 'text' string · 'reasoning' string ·
 *          'done' {text, structured, usage, rawUsage, stopReason, model, sessionId, costUsd, warm} · 'error' Error
 */
export function runClaude(opts) {
  const ev = new EventEmitter();
  const spec = specOf(opts);
  let proc = pool.take(spec.key);
  const warm = !!proc;
  if (warm) pool.stats.warmHits++;
  else {
    pool.stats.coldStarts++;
    proc = spawnProc(spec);
  }
  const { child } = proc;

  let finished = false;
  let succeeded = false;
  let streamedText = '';
  let model = spec.model;
  let sessionId = spec.session.id;

  const fail = (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    ev.emit('error', err);
  };

  const timer = setTimeout(() => {
    child.kill();
    fail(httpError(504, `No answer from Claude Code after ${config.requestTimeoutMs / 1000}s`));
  }, config.requestTimeoutMs);

  const onAbort = () => {
    child.kill();
    fail(httpError(499, 'Request cancelled by client'));
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const spawnFailed = (e) =>
    fail(httpError(500, `Could not run "${config.claudeBin}" (${e.message}). Is Claude Code installed and on PATH? Set CLAUDE_BIN otherwise.`));
  if (proc.spawnError) spawnFailed(proc.spawnError);
  child.on('error', spawnFailed);

  proc.onExit = (code) => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (!finished) {
      const hint = /log ?in|auth|credential/i.test(proc.stderr) ? ' Run `claude` once and log in.' : '';
      fail(httpError(502, `Claude Code exited (code ${code}) without a result.${hint} ${proc.stderr.slice(-800)}`.trim()));
    }
    // Get a process ready for the request that most likely comes next.
    if (succeeded) {
      if (spec.session.mode === 'none') pool.prewarm(spec);
      else pool.prewarm(specOf({ ...opts, session: { mode: 'resume', id: sessionId || spec.session.id } }));
    }
  };

  proc.onLine = handleLine;
  for (const line of proc.lines.splice(0)) handleLine(line);

  function handleLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      model = m.model || model;
      sessionId = m.session_id || sessionId;
      ev.emit('init', { model, sessionId });
    } else if (m.type === 'stream_event' && !m.parent_tool_use_id) {
      const e = m.event;
      if (e?.type === 'content_block_delta') {
        if (e.delta?.type === 'text_delta' && e.delta.text) {
          streamedText += e.delta.text;
          if (!spec.jsonSchema) ev.emit('text', e.delta.text);
        } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
          ev.emit('reasoning', e.delta.thinking);
        }
      }
    } else if (m.type === 'rate_limit_event') {
      lastRateLimit = { ...m.rate_limit_info, seenAt: new Date().toISOString() };
    } else if (m.type === 'result') {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (m.is_error || (m.subtype && m.subtype !== 'success')) {
        const msg = String(m.result || m.subtype || 'unknown error');
        ev.emit('error', httpError(errorStatus(m.api_error_status, msg), msg));
        return;
      }
      succeeded = true;
      const u = m.usage || {};
      const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const completion = u.output_tokens || 0;
      ev.emit('done', {
        text: m.structured_output !== undefined ? JSON.stringify(m.structured_output) : streamedText || m.result || '',
        structured: m.structured_output,
        stopReason: m.stop_reason,
        model,
        sessionId: m.session_id || sessionId,
        costUsd: m.total_cost_usd,
        warm,
        rawUsage: u,
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 },
          completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.thinking_tokens || 0 },
        },
      });
    }
  }

  // One user message on stdin; closing stdin makes the CLI answer and exit.
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: opts.content } }) + '\n');

  return ev;
}

/** The exact CLI arguments PlanBridge would use for a request (for compatibility checks). */
export function buildArgs(opts, promptFile = opts.systemPrompt ? 'system-prompt.txt' : null) {
  return argsOf(specOf(opts), promptFile);
}

/** CLAUDE_BIN may be the claude executable or a .js/.mjs script (run with this Node). */
export function claudeCommand() {
  return /\.[cm]?js$/i.test(config.claudeBin) ? [process.execPath, [config.claudeBin]] : [config.claudeBin, []];
}

/**
 * HTTP status for a failed CLI result. Prefers the API status the CLI reports;
 * falls back to the message text for older CLI versions.
 */
export function errorStatus(apiStatus, msg = '') {
  const s = Number(apiStatus);
  if (s === 429 || /rate.?limit|usage limit|limit reached/i.test(msg)) return 429;
  if (s === 401 || s === 403) return 502; // Claude Code's own login failed; the client's key was fine
  if (s === 529 || s === 503 || /overloaded/i.test(msg)) return 503;
  if (s >= 400 && s < 500) return s === 413 ? 413 : s === 404 ? 404 : 400;
  if (/selected model|not_found_error|invalid_request|API Error: 400/i.test(msg)) return 400;
  return 502;
}

/** If the user pointed the Anthropic env vars at PlanBridge itself, Claude Code would call itself in a loop. */
function childEnv() {
  const env = { ...process.env };
  const base = env.ANTHROPIC_BASE_URL || '';
  if (base && new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0):${config.port}\\b`).test(base)) {
    delete env.ANTHROPIC_BASE_URL;
  }
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (env[k] === config.apiKey) delete env[k];
  return env;
}

export { httpError };
