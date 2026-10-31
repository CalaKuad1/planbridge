// Runs the official, unmodified Claude Code CLI in headless mode and turns its
// stream-json output into a few simple events.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { httpError } from './params.js';

/** Latest plan-usage info reported by the CLI (5h / 7d windows). */
export let lastRateLimit = null;

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
 *          'done' {text, structured, usage, rawUsage, stopReason, model, sessionId, costUsd} · 'error' Error
 */
export function runClaude(opts) {
  const ev = new EventEmitter();
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
    '--model', opts.model,
  ];
  if (opts.effort) args.push('--effort', opts.effort);

  let promptFile = null;
  if (opts.systemPrompt) {
    // a file avoids command-line length/quoting limits (Windows: 32k chars)
    promptFile = path.join(config.tmpDir, `sp-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(promptFile, opts.systemPrompt);
    args.push('--system-prompt-file', promptFile);
  }
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));

  const s = opts.session || { mode: 'none' };
  if (s.mode === 'new') args.push('--session-id', s.id);
  else if (s.mode === 'resume') args.push('--resume', s.id);
  else args.push('--no-session-persistence');

  const child = spawn(config.claudeBin, args, {
    cwd: config.workspaceDir,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let finished = false;
  let stderr = '';
  let buf = '';
  let streamedText = '';
  let model = opts.model;
  let sessionId = s.id || null;

  const cleanup = () => promptFile && fs.rm(promptFile, { force: true }, () => {});
  const fail = (err) => {
    if (finished) return;
    finished = true;
    cleanup();
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

  child.on('error', (e) =>
    fail(httpError(500, `Could not run "${config.claudeBin}" (${e.message}). Is Claude Code installed and on PATH? Set CLAUDE_BIN otherwise.`)),
  );
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(line);
    }
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (buf.trim()) handleLine(buf.trim());
    if (!finished) {
      const hint = /log ?in|auth|credential/i.test(stderr) ? ' Run `claude` once and log in.' : '';
      fail(httpError(502, `Claude Code exited (code ${code}) without a result.${hint} ${stderr.slice(-800)}`.trim()));
    }
  });

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
          if (!opts.jsonSchema) ev.emit('text', e.delta.text);
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
      cleanup();
      if (m.is_error || (m.subtype && m.subtype !== 'success')) {
        const msg = String(m.result || m.subtype || 'unknown error');
        const status = /rate.?limit|usage limit|limit reached|429/i.test(msg)
          ? 429
          : /selected model|not_found_error|invalid_request|API Error: 400/i.test(msg)
            ? 400
            : 502;
        ev.emit('error', httpError(status, msg));
        return;
      }
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
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: opts.content } }) + '\n');

  return ev;
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
