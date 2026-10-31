// Summarise any file (txt, md, pdf, image…) with zero dependencies.
//   node examples/summarize.mjs report.pdf
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2];
if (!file) throw new Error('usage: node summarize.mjs <file>');
const key = process.env.PLANBRIDGE_API_KEY || fs.readFileSync(path.join(os.homedir(), '.planbridge', 'api-key.txt'), 'utf8').trim();
const ext = path.extname(file).toLowerCase();
const mime = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'text/plain';
const data = fs.readFileSync(file).toString('base64');
const part = mime.startsWith('image/')
  ? { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }
  : { type: 'file', file: { filename: path.basename(file), file_data: `data:${mime};base64,${data}` } };

const res = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: [part, { type: 'text', text: 'Summarise this in 5 bullet points.' }] }] }),
});
const j = await res.json();
console.log(res.ok ? j.choices[0].message.content : j.error.message);
