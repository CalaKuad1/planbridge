import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, MODELS, ROOT, VERSION } from './config.js';
import { runClaude, lastRateLimit, pool } from './claude.js';
import { convertMessages, textOf } from './convert.js';
import { sessions } from './sessions.js';
import { httpError, pickModel, pickEffort, pickSchema, validateSessionId } from './params.js';

// ---------- limits: concurrency + requests per minute ----------
let active = 0;
const queue = [];
const recent = [];

function acquire() {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  if (config.rateLimitPerMin > 0 && recent.length >= config.rateLimitPerMin) {
    throw httpError(429, `Local limit of ${config.rateLimitPerMin} requests/minute reached`);
  }
  recent.push(now);
  if (active < config.maxConcurrent) {
    active++;
    return Promise.resolve();
  }
  if (queue.length >= config.maxQueue) throw httpError(429, 'Queue is full, try again shortly');
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  const next = queue.shift();
  if (next) next();
  else active--;
}

// ---------- HTTP helpers ----------
function cors(res) {
  if (!config.corsOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Session-Id, x-api-key, anthropic-version, anthropic-beta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Session-Id');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function errorType(status) {
  return status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'api_error';
}

function sendError(res, err, flavor = 'openai') {
  const status = err.status || 500;
  if (status >= 500) console.error('[planbridge]', err.message);
  if (flavor === 'anthropic') return sendJson(res, status, { type: 'error', error: { type: errorType(status), message: err.message } });
  sendJson(res, status, { error: { message: err.message, type: errorType(status), code: status } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        reject(httpError(413, `Body too large (max ${config.maxBodyBytes / 1048576} MB)`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : req.headers['x-api-key'] || '';
  const a = Buffer.from(String(key));
  const b = Buffer.from(config.apiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError(401, 'Invalid API key. Find yours with: planbridge key');
  }
}

const sse = (res) =>
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });

// ---------- core: one chat turn, independent of the wire format ----------
/**
 * @param {object} p
 * @param {Array} p.messages OpenAI-style messages (system messages included)
 * @param {(ev, ctx) => Promise} p.respond writes the response in the caller's format
 */
async function runTurn(req, res, { body, messages, respond }) {
  const model = pickModel(body.model, config.defaultModel);
  const effort = pickEffort(body, config.defaultEffort);
  const { schema, extra } = pickSchema(body);
  let convId = validateSessionId(body.session_id || body.metadata?.session_id || req.headers['x-session-id']);
  if (!convId && body.session === true) convId = sessions.newId();

  const turn = async () => {
    let session = { mode: 'none' };
    let onlyNew = false;
    if (convId) {
      const s = sessions.open(convId);
      session = { mode: s.isNew ? 'new' : 'resume', id: s.claudeSessionId };
      onlyNew = !s.isNew;
    }
    const { system, content } = await convertMessages(messages, { onlyNew });
    const systemPrompt = [system || config.defaultSystemPrompt, extra].filter(Boolean).join('\n\n');

    await acquire();
    const ac = new AbortController();
    const onClose = () => !res.writableFinished && ac.abort();
    res.on('close', onClose);
    try {
      if (convId) res.setHeader('X-Session-Id', convId);
      const ev = runClaude({ content, model, effort, systemPrompt, jsonSchema: schema, session, signal: ac.signal });
      await respond(ev, { model, convId });
      if (convId) sessions.touch(convId, model);
    } finally {
      res.off('close', onClose);
      release();
    }
  };

  if (convId) await sessions.withLock(convId, turn);
  else await turn();
}

const finishReason = (r) => (r === 'max_tokens' ? 'length' : 'stop');
const newId = (p) => p + crypto.randomBytes(12).toString('hex');

// ---------- OpenAI: POST /v1/chat/completions ----------
async function openaiChat(req, res) {
  const body = await readBody(req);
  await runTurn(req, res, {
    body,
    messages: body.messages,
    respond: (ev, ctx) => (body.stream ? openaiStream(res, ev, body, ctx) : openaiJson(res, ev, ctx)),
  });
}

function openaiJson(res, ev, { convId }) {
  return new Promise((resolve, reject) => {
    let reasoning = '';
    ev.on('reasoning', (t) => (reasoning += t));
    ev.on('error', reject);
    ev.on('done', (r) => {
      const message = { role: 'assistant', content: r.text };
      if (reasoning) message.reasoning_content = reasoning;
      sendJson(res, 200, {
        id: newId('chatcmpl-'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: r.model,
        choices: [{ index: 0, message, finish_reason: finishReason(r.stopReason) }],
        usage: r.usage,
        ...(convId ? { session_id: convId } : {}),
        ...(r.structured !== undefined ? { parsed: r.structured } : {}),
      });
      resolve();
    });
  });
}

function openaiStream(res, ev, body, { model: requested, convId }) {
  return new Promise((resolve, reject) => {
    const id = newId('chatcmpl-');
    const created = Math.floor(Date.now() / 1000);
    let model = requested;
    let started = false;
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, finish = null, extra = {}) =>
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    const start = () => {
      if (started) return;
      started = true;
      sse(res);
      chunk({ role: 'assistant', content: '' }, null, convId ? { session_id: convId } : {});
    };

    ev.on('init', (i) => ((model = i.model || model), start()));
    ev.on('reasoning', (t) => (start(), chunk({ reasoning_content: t })));
    ev.on('text', (t) => (start(), chunk({ content: t })));
    ev.on('error', (err) => {
      if (!started) return reject(err); // still able to send a normal HTTP error
      write({ error: { message: err.message, type: errorType(err.status || 500), code: err.status || 500 } });
      res.end('data: [DONE]\n\n');
      resolve();
    });
    ev.on('done', (r) => {
      start();
      if (r.structured !== undefined) chunk({ content: r.text }); // json_schema results arrive at the end
      chunk({}, finishReason(r.stopReason));
      if (body.stream_options?.include_usage) write({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: r.usage });
      res.end('data: [DONE]\n\n');
      resolve();
    });
  });
}

// ---------- Anthropic: POST /v1/messages ----------
async function anthropicMessages(req, res) {
  const body = await readBody(req);
  if (!Array.isArray(body.messages)) throw httpError(400, 'messages: array required');
  const system = typeof body.system === 'string' ? body.system : textOf(body.system || []);
  const messages = [...(system ? [{ role: 'system', content: system }] : []), ...body.messages];
  await runTurn(req, res, {
    body,
    messages,
    respond: (ev, ctx) => (body.stream ? anthropicStream(res, ev, ctx) : anthropicJson(res, ev, ctx)),
  });
}

const anthropicUsage = (u = {}) => ({
  input_tokens: u.input_tokens || 0,
  output_tokens: u.output_tokens || 0,
  cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  cache_read_input_tokens: u.cache_read_input_tokens || 0,
});
const anthropicStop = (r) => r || 'end_turn';

function anthropicJson(res, ev, { convId }) {
  return new Promise((resolve, reject) => {
    ev.on('error', reject);
    ev.on('done', (r) => {
      sendJson(res, 200, {
        id: newId('msg_'),
        type: 'message',
        role: 'assistant',
        model: r.model,
        content: [{ type: 'text', text: r.text }],
        stop_reason: anthropicStop(r.stopReason),
        stop_sequence: null,
        usage: anthropicUsage(r.rawUsage),
        ...(convId ? { session_id: convId } : {}),
      });
      resolve();
    });
  });
}

function anthropicStream(res, ev, { model: requested }) {
  return new Promise((resolve, reject) => {
    const id = newId('msg_');
    let started = false;
    let model = requested;
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    const start = () => {
      if (started) return;
      started = true;
      sse(res);
      send('message_start', {
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    };
    ev.on('init', (i) => ((model = i.model || model), start()));
    ev.on('text', (t) => (start(), send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })));
    ev.on('error', (err) => {
      if (!started) return reject(err);
      send('error', { error: { type: errorType(err.status || 500), message: err.message } });
      res.end();
      resolve();
    });
    ev.on('done', (r) => {
      start();
      if (r.structured !== undefined) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: r.text } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: anthropicStop(r.stopReason), stop_sequence: null }, usage: anthropicUsage(r.rawUsage) });
      send('message_stop', {});
      res.end();
      resolve();
    });
  });
}

// ---------- router ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/playground': ['index.html', 'text/html; charset=utf-8'],
  '/sdk.js': ['sdk.js', 'text/javascript; charset=utf-8'],
};

async function handle(req, res) {
  cors(res);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const flavor = p === '/v1/messages' ? 'anthropic' : 'openai';
  try {
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(ROOT, 'public', file)).pipe(res);
    }
    if (req.method === 'GET' && p === '/health') {
      return sendJson(res, 200, { ok: true, name: 'planbridge', version: VERSION, active, queued: queue.length, default_model: config.defaultModel, warm_pool: pool.info() });
    }

    checkAuth(req);

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) return await openaiChat(req, res);
    if (req.method === 'POST' && p === '/v1/messages') return await anthropicMessages(req, res);
    if (req.method === 'GET' && p === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((id) => ({ id, object: 'model', type: 'model', display_name: id, created: 0, owned_by: 'anthropic' })),
      });
    }
    if (req.method === 'GET' && p === '/v1/sessions') return sendJson(res, 200, { data: sessions.list() });
    if (req.method === 'DELETE' && p.startsWith('/v1/sessions/')) {
      const id = decodeURIComponent(p.slice('/v1/sessions/'.length));
      const s = sessions.get(id);
      if (s) pool.dropSession(s.claudeSessionId);
      const ok = sessions.remove(id);
      return sendJson(res, ok ? 200 : 404, { deleted: ok });
    }
    if (req.method === 'GET' && p === '/v1/limits') {
      return sendJson(res, 200, { rate_limit: lastRateLimit, ...(lastRateLimit ? {} : { note: 'No data yet — make a request first' }) });
    }
    throw httpError(404, `Not found: ${req.method} ${p}`);
  } catch (err) {
    if (err.status === 499) return; // client went away
    sendError(res, err, flavor);
  }
}

export function startServer({ quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') e.message = `Port ${config.port} is already in use — is PlanBridge already running? (planbridge status)`;
      reject(e);
    });
    server.listen(config.port, config.host, () => {
      const local = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
      const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
      if (!quiet) {
        console.log(`\n  PlanBridge v${VERSION} — your Claude Code subscription as a local API\n`);
        console.log(`  Playground   http://${shown}:${config.port}/`);
        console.log(`  OpenAI       http://${shown}:${config.port}/v1   (chat/completions)`);
        console.log(`  Anthropic    http://${shown}:${config.port}      (v1/messages)`);
        console.log(`  API key      ${config.apiKey}`);
        console.log(`  Model        ${config.defaultModel} · ${config.maxConcurrent} parallel · ${config.rateLimitPerMin}/min\n`);
        if (!local) console.warn('  ⚠  Listening beyond localhost. Personal use only — never share this with other people.\n');
      }
      resolve(server);
    });
  });
}
