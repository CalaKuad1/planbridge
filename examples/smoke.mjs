// End-to-end smoke test against a running server:  planbridge start  →  npm run smoke [testName]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3456/v1';
const ORIGIN = BASE.slice(0, -3); // strip /v1
const KEY = process.env.API_KEY || fs.readFileSync(path.join(process.env.PLANBRIDGE_HOME || path.join(os.homedir(), '.planbridge'), 'api-key.txt'), 'utf8').trim();
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function chat(body, headers = {}) {
  const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify({ model: 'haiku', ...body }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
}

function redPng() {
  const w = 32, h = 32, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 255;
  const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const ch = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
}

const tests = {
  async text() {
    const j = await chat({ messages: [{ role: 'user', content: 'Reply with just: pong' }] });
    return j.choices[0].message.content;
  },
  async systemPrompt() {
    const j = await chat({ messages: [{ role: 'system', content: 'You are a pirate. Always start your reply with "Arr!"' }, { role: 'user', content: 'Hello' }] });
    return j.choices[0].message.content;
  },
  async statelessHistory() {
    const j = await chat({
      messages: [
        { role: 'user', content: 'My name is Ada.' },
        { role: 'assistant', content: 'Nice to meet you, Ada!' },
        { role: 'user', content: 'What is my name? One word.' },
      ],
    });
    return j.choices[0].message.content;
  },
  async image() {
    const j = await chat({
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'What colour is this image? One word.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + redPng().toString('base64') } },
      ] }],
    });
    return j.choices[0].message.content;
  },
  async textFile() {
    const j = await chat({
      messages: [{ role: 'user', content: [
        { type: 'file', file: { filename: 'notes.txt', file_data: 'data:text/plain;base64,' + Buffer.from('The garage code is 7731.').toString('base64') } },
        { type: 'text', text: 'What is the garage code? Just the number.' },
      ] }],
    });
    return j.choices[0].message.content;
  },
  async jsonSchema() {
    const j = await chat({
      messages: [{ role: 'user', content: 'Name one red fruit' }],
      response_format: { type: 'json_schema', json_schema: { name: 'fruit', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    });
    return j.choices[0].message.content;
  },
  async session() {
    const id = 'test-' + Date.now();
    await chat({ session_id: id, messages: [{ role: 'user', content: 'Remember: my lucky number is 88. Reply OK.' }] });
    const j = await chat({ session_id: id, messages: [{ role: 'user', content: 'What is my lucky number? Just the number.' }] });
    await fetch(`${BASE}/sessions/${id}`, { method: 'DELETE', headers: H });
    return j.choices[0].message.content;
  },
  async streaming() {
    const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'haiku', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Count from 1 to 5, comma separated' }] }) });
    let text = '', chunks = 0, usage = null;
    for (const line of (await r.text()).split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const j = JSON.parse(line.slice(6));
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta?.content;
      if (d) (text += d), chunks++;
    }
    return `${text}  (${chunks} chunks, ${usage?.total_tokens} tokens)`;
  },
  async anthropic() {
    const r = await fetch(ORIGIN + '/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'haiku', max_tokens: 50, system: 'Reply in English.', messages: [{ role: 'user', content: 'Say: bridge ok' }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j.content[0].text + ' / stop_reason=' + j.stop_reason;
  },
  async sdkJs() {
    const r = await fetch(ORIGIN + '/sdk.js');
    return `HTTP ${r.status}, ${(await r.text()).length} bytes`;
  },
  async noAuth() {
    const r = await fetch(`${BASE}/models`);
    return `HTTP ${r.status}`;
  },
};

const EXPECT = {
  text: /pong/i, systemPrompt: /^\W*arr/i, statelessHistory: /ada/i, image: /red/i, textFile: /7731/,
  jsonSchema: /"name":/, session: /88/, streaming: /1, ?2, ?3, ?4, ?5/, anthropic: /bridge ok/i, sdkJs: /HTTP 200/, noAuth: /HTTP 401/,
};
let failures = 0;
const only = process.argv[2];
for (const [name, fn] of Object.entries(tests)) {
  if (only && name !== only) continue;
  const t = Date.now();
  try {
    const out = String(await fn()).replace(/\s+/g, ' ').slice(0, 120);
    const good = !EXPECT[name] || EXPECT[name].test(out);
    if (!good) failures++;
    console.log(`${good ? '✔' : '✘'} ${name.padEnd(18)} ${((Date.now() - t) / 1000).toFixed(1)}s  ${out}`);
  } catch (e) {
    failures++;
    console.log(`✘ ${name.padEnd(18)} ${e.message.slice(0, 300)}`);
  }
}
process.exitCode = failures ? 1 : 0;
