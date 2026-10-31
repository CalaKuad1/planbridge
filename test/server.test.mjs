// Integration tests: the real PlanBridge server against a fake `claude` CLI
// (test/fixtures/fake-claude.mjs). No network, no Claude account needed.
import './setup.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
Object.assign(process.env, {
  CLAUDE_BIN: path.join(here, 'fixtures', 'fake-claude.mjs'),
  CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pb-claude-')),
  PLANBRIDGE_PORT: '0',
  PLANBRIDGE_API_KEY: 'pb-test-key',
  REQUEST_TIMEOUT_MS: '2500',
  MAX_CONCURRENT: '1',
  MAX_QUEUE: '1',
  RATE_LIMIT_PER_MIN: '1000',
  WARM_POOL: '2',
  DEFAULT_SYSTEM_PROMPT: 'DEFAULT PROMPT',
});

const { startServer } = await import('../src/server.js');
const { sessions, transcriptDir } = await import('../src/sessions.js');
const { errorStatus, shutdown } = await import('../src/claude.js');
const server = await startServer({ quiet: true });
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.closeAllConnections();
  server.close();
  shutdown();
});

const H = { Authorization: 'Bearer pb-test-key', 'Content-Type': 'application/json' };
const post = (p, body, headers = H) => fetch(BASE + p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const chat = async (body) => {
  const r = await post('/v1/chat/completions', { model: 'haiku', ...body });
  return { status: r.status, headers: r.headers, json: await r.json() };
};
const say = (content, extra = {}) => chat({ messages: [{ role: 'user', content }], ...extra });
const sseEvents = (text) =>
  text.split('\n\n').map((b) => b.trim()).filter(Boolean).map((b) => ({
    event: /^event: (.*)$/m.exec(b)?.[1],
    data: /^data: (.*)$/m.exec(b)?.[1],
  }));

// ---------------------------------------------------------------- basics

test('health is public, everything else needs the key', async () => {
  const h = await (await fetch(BASE + '/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.name, 'planbridge');
  assert.equal((await fetch(BASE + '/v1/models')).status, 401);
  assert.equal((await fetch(BASE + '/v1/models', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const m = await (await fetch(BASE + '/v1/models', { headers: { 'x-api-key': 'pb-test-key' } })).json();
  assert.ok(m.data.some((x) => x.id === 'sonnet'));
});

test('serves the playground and the browser SDK', async () => {
  assert.match(await (await fetch(BASE + '/')).text(), /PlanBridge/);
  const sdk = await fetch(BASE + '/sdk.js');
  assert.match(sdk.headers.get('content-type'), /javascript/);
  assert.match(await sdk.text(), /root\.PlanBridge = PlanBridge/);
});

test('chat completion: text, model, usage', async () => {
  const { status, json } = await say('hello there');
  assert.equal(status, 200);
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.model, 'claude-haiku-5-5');
  assert.equal(json.choices[0].message.content, 'echo: hello there');
  assert.equal(json.choices[0].finish_reason, 'stop');
  assert.deepEqual(
    [json.usage.prompt_tokens, json.usage.completion_tokens, json.usage.prompt_tokens_details.cached_tokens, json.usage.completion_tokens_details.reasoning_tokens],
    [115, 7, 100, 3],
  );
});

test('runs the CLI isolated: no tools, safe mode, no persistence', async () => {
  const argv = JSON.parse((await say('ARGS?', { model: 'opus', reasoning_effort: 'high' })).json.choices[0].message.content);
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(after('--tools'), '');
  assert.ok(argv.includes('--safe-mode'));
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.ok(argv.includes('--no-session-persistence'));
  assert.equal(after('--model'), 'opus');
  assert.equal(after('--effort'), 'high');
  assert.equal(after('--input-format'), 'stream-json');
});

test('system prompt: from the request, or the default', async () => {
  const own = await chat({ messages: [{ role: 'system', content: 'You are a pirate.' }, { role: 'user', content: 'SYSTEM?' }] });
  assert.equal(own.json.choices[0].message.content, 'You are a pirate.');
  assert.equal((await say('SYSTEM?')).json.choices[0].message.content, 'DEFAULT PROMPT');
  const jo = await say('SYSTEM?', { response_format: { type: 'json_object' } });
  assert.match(jo.json.choices[0].message.content, /valid JSON object/);
});

test('images, PDFs and text files reach the CLI as content blocks', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const { json } = await say([
    { type: 'text', text: 'COUNT_BLOCKS?' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}` } },
  ]);
  assert.equal(json.choices[0].message.content, '1 images, 1 documents, 1 texts');
});

test('stateless history is passed along', async () => {
  const { json } = await chat({
    messages: [
      { role: 'user', content: 'my name is Ana' },
      { role: 'assistant', content: 'hi Ana' },
      { role: 'user', content: 'what is my name?' },
    ],
  });
  assert.match(json.choices[0].message.content, /<conversation_history>[\s\S]*my name is Ana[\s\S]*what is my name\?/);
});

test('json_schema returns validated JSON and parsed', async () => {
  const { json } = await say('fruit', { response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } } });
  assert.deepEqual(JSON.parse(json.choices[0].message.content), { echo: 'fruit' });
  assert.deepEqual(json.parsed, { echo: 'fruit' });
});

// ---------------------------------------------------------------- streaming

test('OpenAI streaming: role chunk, content chunks, finish, usage, [DONE]', async () => {
  const r = await post('/v1/chat/completions', { model: 'haiku', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'stream me please' }] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const ev = sseEvents(await r.text());
  assert.equal(ev.at(-1).data, '[DONE]');
  const chunks = ev.slice(0, -1).map((e) => JSON.parse(e.data));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const text = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
  assert.equal(text, 'echo: stream me please');
  assert.ok(chunks.filter((c) => c.choices[0]?.delta?.content).length > 1, 'arrives in several chunks');
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason, 'stop');
  assert.equal(chunks.at(-1).usage.total_tokens, 122);
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
});

test('streaming errors before the first token keep their HTTP status', async () => {
  const r = await post('/v1/chat/completions', { model: 'haiku', stream: true, messages: [{ role: 'user', content: 'FAIL_RATE' }] });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.type, 'rate_limit_error');
});

// ---------------------------------------------------------------- Anthropic format

test('Anthropic /v1/messages', async () => {
  const r = await post('/v1/messages', { model: 'haiku', max_tokens: 100, system: [{ type: 'text', text: 'SYS' }], messages: [{ role: 'user', content: 'SYSTEM?' }] });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.type, 'message');
  assert.equal(j.role, 'assistant');
  assert.deepEqual(j.content, [{ type: 'text', text: 'SYS' }]);
  assert.equal(j.stop_reason, 'end_turn');
  assert.equal(j.usage.input_tokens, 10);
  assert.equal(j.usage.cache_read_input_tokens, 100);
});

test('Anthropic streaming event sequence', async () => {
  const r = await post('/v1/messages', { model: 'haiku', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hey' }] });
  const ev = sseEvents(await r.text());
  const names = [...new Set(ev.map((e) => e.event))];
  assert.deepEqual(names, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const text = ev.filter((e) => e.event === 'content_block_delta').map((e) => JSON.parse(e.data).delta.text).join('');
  assert.equal(text, 'echo: hey');
  assert.equal(JSON.parse(ev.find((e) => e.event === 'message_delta').data).delta.stop_reason, 'end_turn');
});

test('Anthropic errors use the Anthropic error shape', async () => {
  const r = await post('/v1/messages', { model: 'haiku', max_tokens: 10, messages: [{ role: 'user', content: 'FAIL_RATE' }] });
  const j = await r.json();
  assert.equal(r.status, 429);
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'rate_limit_error');
});

// ---------------------------------------------------------------- sessions

test('sessions: first turn --session-id, then --resume with only the new message', async () => {
  const sid = 'chat-' + Date.now();
  const a1 = JSON.parse((await chat({ session_id: sid, messages: [{ role: 'user', content: 'ARGS?' }] })).json.choices[0].message.content);
  const uuid = a1[a1.indexOf('--session-id') + 1];
  assert.match(uuid, /^[0-9a-f-]{36}$/);

  const r2 = await chat({ session_id: sid, messages: [{ role: 'user', content: 'ARGS?' }] });
  const a2 = JSON.parse(r2.json.choices[0].message.content);
  assert.equal(a2[a2.indexOf('--resume') + 1], uuid);
  assert.equal(r2.json.session_id, sid);
  assert.equal(r2.headers.get('x-session-id'), sid);

  // even if the app sends the whole history, only the new turn is forwarded
  const r3 = await chat({ session_id: sid, messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'new one' }] });
  assert.equal(r3.json.choices[0].message.content, 'echo: new one');
  assert.equal(sessions.get(sid).turns, 3);
});

test('session: true creates an id; DELETE forgets it and its transcript', async () => {
  const { json, headers } = await say('hi', { session: true });
  assert.match(json.session_id, /^conv_/);
  assert.equal(headers.get('x-session-id'), json.session_id);

  const uuid = sessions.get(json.session_id).claudeSessionId;
  fs.mkdirSync(transcriptDir(), { recursive: true });
  const file = path.join(transcriptDir(), `${uuid}.jsonl`);
  fs.writeFileSync(file, '{}\n');

  const list = await (await fetch(BASE + '/v1/sessions', { headers: H })).json();
  assert.ok(list.data.some((s) => s.id === json.session_id));
  const del = await fetch(BASE + `/v1/sessions/${json.session_id}`, { method: 'DELETE', headers: H });
  assert.equal(del.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(file), false);
  assert.equal(sessions.get(json.session_id), null);
  assert.equal((await fetch(BASE + `/v1/sessions/${json.session_id}`, { method: 'DELETE', headers: H })).status, 404);
});

test('old sessions are pruned', async () => {
  const { json } = await say('hi', { session_id: 'to-prune' });
  assert.equal(json.session_id, 'to-prune');
  assert.equal(sessions.prune(Date.now() + 31 * 86400000) >= 1, true);
  assert.equal(sessions.get('to-prune'), null);
});

// ---------------------------------------------------------------- errors & limits

test('CLI errors map to HTTP statuses', async () => {
  const rate = await say('FAIL_RATE');
  assert.equal(rate.status, 429);
  assert.match(rate.json.error.message, /usage limit/);
  assert.equal((await say('FAIL_MODEL')).status, 404);
  const crash = await say('CRASH');
  assert.equal(crash.status, 502);
  assert.match(crash.json.error.message, /code 3[\s\S]*boom/);
});

test('timeouts return 504', async () => {
  const r = await say('HANG');
  assert.equal(r.status, 504);
});

test('bad requests', async () => {
  assert.equal((await post('/v1/chat/completions', '{nope')).status, 400);
  assert.equal((await chat({ messages: [] })).status, 400);
  assert.equal((await chat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).status, 400);
  assert.equal((await say('x', { session_id: '../../etc' })).status, 400);
  assert.equal((await say('x', { reasoning_effort: 'turbo' })).status, 400);
  const zip = await say([{ type: 'file', file: { filename: 'a.zip', file_data: 'data:application/zip;base64,UEsDBA==' } }]);
  assert.equal(zip.status, 415);
  assert.equal((await fetch(BASE + '/v1/nothing', { headers: H })).status, 404);
});

test('concurrency limit queues one request and rejects the overflow', async () => {
  const results = await Promise.all([say('SLOW 1'), say('SLOW 2'), say('SLOW 3')]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 429]);
});

test('a client that disconnects frees its slot', async () => {
  const ac = new AbortController();
  const req = fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'haiku', messages: [{ role: 'user', content: 'HANG' }] }), signal: ac.signal });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await (await fetch(BASE + '/health')).json()).active, 1, 'request is running');
  ac.abort();
  await req.catch(() => {});
  await new Promise((r) => setTimeout(r, 300)); // well before the 2.5 s timeout
  assert.equal((await (await fetch(BASE + '/health')).json()).active, 0);
  assert.equal((await say('still works')).status, 200);
});

// ---------------------------------------------------------------- warm pool

test('warm pool reuses a pre-started process for the next identical request', async () => {
  const before = (await (await fetch(BASE + '/health')).json()).warm_pool;
  await say('warm 1', { model: 'sonnet' });
  await new Promise((r) => setTimeout(r, 300));
  await say('warm 2', { model: 'sonnet' });
  const now = (await (await fetch(BASE + '/health')).json()).warm_pool;
  assert.ok(now.warmHits > before.warmHits, `warm hits ${before.warmHits} -> ${now.warmHits}`);
  assert.ok(now.size <= now.max);
});

test('plan usage is exposed at /v1/limits', async () => {
  const l = await (await fetch(BASE + '/v1/limits', { headers: H })).json();
  assert.equal(l.rate_limit.unifiedWindows.five_hour.utilization, 0.25);
});

// ---------------------------------------------------------------- pure helper

test('errorStatus prefers the API status, falls back to the message', () => {
  assert.equal(errorStatus(429), 429);
  assert.equal(errorStatus(undefined, "You've hit your usage limit"), 429);
  assert.equal(errorStatus(404), 404);
  assert.equal(errorStatus(400), 400);
  assert.equal(errorStatus(401), 502);
  assert.equal(errorStatus(529), 503);
  assert.equal(errorStatus(undefined, "There's an issue with the selected model"), 400);
  assert.equal(errorStatus(undefined, 'weird'), 502);
});
