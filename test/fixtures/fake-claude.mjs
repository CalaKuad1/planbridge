#!/usr/bin/env node
// A stand-in for the `claude` CLI used by the integration tests.
// It speaks the same --input-format/--output-format stream-json protocol as the
// real CLI (as of the version in package.json "planbridge.testedClaudeCode"),
// never touches the network, and records its arguments.
//
// The reply depends on keywords in the user message:
//   FAIL_RATE     -> error result, api_error_status 429
//   FAIL_MODEL    -> error result, api_error_status 404
//   CRASH         -> exits with code 3 and no result
//   HANG          -> never answers (timeout tests)
//   SLOW          -> waits 600 ms before answering
//   SYSTEM?       -> replies with the system prompt it was given
//   ARGS?         -> replies with its argv as JSON
//   COUNT_BLOCKS? -> replies with "<images> images, <documents> documents, <texts> texts"
//   otherwise     -> "echo: <text of the message>"
// With --json-schema it returns structured_output {"echo": "<text>"}.
import fs from 'node:fs';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, argv }) + '\n');
}

if (argv[0] === '--version') {
  console.log('2.1.316 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}

const model = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }[arg('--model')] || arg('--model') || 'claude-sonnet-5-5';
const sessionId = arg('--session-id') || arg('--resume') || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + '\n');

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const line = input.split('\n').find((l) => l.trim());
  if (!line) process.exit(0); // stdin closed with nothing (e.g. an unused warm process)
  const msg = JSON.parse(line).message;
  const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  out({ type: 'system', subtype: 'init', model, tools: [], cwd: process.cwd() });

  if (text.includes('HANG')) return setInterval(() => {}, 1000);
  if (text.includes('CRASH')) {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  if (text.includes('SLOW')) await new Promise((r) => setTimeout(r, 600));

  const fail = (status, message) => {
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: status, result: message, usage: {} });
    process.exit(0);
  };
  if (text.includes('FAIL_RATE')) return fail(429, "You've hit your usage limit");
  if (text.includes('FAIL_MODEL')) return fail(404, "There's an issue with the selected model");

  let reply;
  if (text.includes('SYSTEM?')) reply = arg('--system-prompt-file') ? fs.readFileSync(arg('--system-prompt-file'), 'utf8') : '(none)';
  else if (text.includes('ARGS?')) reply = JSON.stringify(argv);
  else if (text.includes('COUNT_BLOCKS?')) {
    const n = (t) => blocks.filter((b) => b.type === t).length;
    reply = `${n('image')} images, ${n('document')} documents, ${n('text')} texts`;
  } else reply = `echo: ${text}`;

  const schema = arg('--json-schema');
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } };

  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { model } } });
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } });
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
  const pieces = schema ? [JSON.stringify({ echo: text })] : reply.match(/.{1,6}/gs) || [''];
  for (const p of pieces) {
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } } });
  }
  out({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: reply }] } });
  out({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1900000000, status: 'allowed' }, seven_day: { utilization: 0.1, resetsAt: 1900000000, status: 'allowed' } } },
  });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    result: schema ? JSON.stringify({ echo: text }) : reply,
    ...(schema ? { structured_output: { echo: text } } : {}),
    total_cost_usd: 0.0001,
    usage,
  });
});
