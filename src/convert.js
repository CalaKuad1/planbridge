// Converts OpenAI-style messages (and native Anthropic blocks) into the content Claude Code accepts.
import { httpError } from './params.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_REMOTE_BYTES = 20 * 1024 * 1024;

function parseDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  const data = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString('base64');
  return { mime, data };
}

async function fetchAsBase64(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'planbridge' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw httpError(400, `Could not download ${url}: ${e.message}`);
  }
  if (!res.ok) throw httpError(400, `Could not download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_REMOTE_BYTES) throw httpError(413, `Remote file too large: ${url}`);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { mime: mime || sniffMime(buf), data: buf.toString('base64') };
}

function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  return 'application/octet-stream';
}

function isTextMime(mime, filename = '') {
  return (
    mime.startsWith('text/') ||
    /json|xml|javascript|typescript|yaml|csv|markdown|x-sh|sql/.test(mime) ||
    /\.(txt|md|csv|json|js|ts|py|html|css|xml|ya?ml|sql|log|ini|toml|sh)$/i.test(filename)
  );
}

/** File (mime + base64) -> the right content block. */
function fileBlock({ mime, data }, filename) {
  if (mime === 'application/octet-stream') mime = sniffMime(Buffer.from(data.slice(0, 64), 'base64'));
  if (IMAGE_TYPES.includes(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  }
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, ...(filename ? { title: filename } : {}) };
  }
  if (isTextMime(mime, filename)) {
    const text = Buffer.from(data, 'base64').toString('utf8');
    return { type: 'text', text: `<file name="${filename || 'file'}">\n${text}\n</file>` };
  }
  throw httpError(415, `Unsupported file type: ${mime}${filename ? ` (${filename})` : ''}. Use images, PDF or text files.`);
}

async function urlToBlock(url, filename) {
  if (typeof url !== 'string') throw httpError(400, 'Invalid image/file URL');
  const parsed = url.startsWith('data:') ? parseDataUrl(url) : await fetchAsBase64(url);
  if (!parsed) throw httpError(400, 'Invalid data URL');
  return fileBlock(parsed, filename);
}

/** One content part (OpenAI or Anthropic) -> Anthropic blocks */
async function partToBlocks(part) {
  if (typeof part === 'string') return [{ type: 'text', text: part }];
  switch (part?.type) {
    case 'text':
    case 'input_text':
      return part.text ? [{ type: 'text', text: part.text }] : [];
    case 'image_url': {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      return [await urlToBlock(url)];
    }
    case 'input_image':
      return [await urlToBlock(part.image_url || part.url)];
    case 'file':
    case 'input_file': {
      const f = part.file || part;
      if (f.file_data) {
        const p = f.file_data.startsWith('data:') ? parseDataUrl(f.file_data) : { mime: 'application/octet-stream', data: f.file_data };
        return [fileBlock(p, f.filename)];
      }
      if (f.file_url || f.url) return [await urlToBlock(f.file_url || f.url, f.filename)];
      throw httpError(400, '"file" part needs file_data or a url (file_id is not supported)');
    }
    case 'image':
    case 'document': {
      // native Anthropic block
      if (part.source?.type === 'url') return [await urlToBlock(part.source.url, part.title)];
      return [part];
    }
    default:
      return [];
  }
}

async function contentToBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return partToBlocks(content);
  const out = [];
  for (const p of content) out.push(...(await partToBlocks(p)));
  return out;
}

export const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
      : '';

/**
 * @param {Array} messages  OpenAI-style messages
 * @param {{onlyNew:boolean}} o  onlyNew=true (existing session): only send messages after the last assistant reply
 * @returns {{system:string, content:Array}}
 */
export async function convertMessages(messages, { onlyNew = false } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) throw httpError(400, '"messages" must be a non-empty array');

  const system = messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');

  // "Current" turn: user/tool messages after the last assistant reply
  let lastAssistant = -1;
  convo.forEach((m, i) => m.role === 'assistant' && (lastAssistant = i));
  const current = convo.slice(lastAssistant + 1);
  const history = onlyNew ? [] : convo.slice(0, lastAssistant + 1);

  if (current.length === 0) throw httpError(400, 'The last message must be from the user');

  const content = [];
  if (history.length) {
    content.push({
      type: 'text',
      text: 'Here is the conversation so far. Continue it naturally; do not mention this transcript unless relevant.\n<conversation_history>',
    });
    for (const m of history) {
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool_result' : 'user';
      content.push({ type: 'text', text: `<${role}>` });
      content.push(...(await contentToBlocks(m.content)));
      content.push({ type: 'text', text: `</${role}>` });
    }
    content.push({ type: 'text', text: '</conversation_history>\n\nNew user message:' });
  }
  for (const m of current) {
    if (m.role === 'tool') content.push({ type: 'text', text: `Tool result: ${textOf(m.content)}` });
    else content.push(...(await contentToBlocks(m.content)));
  }

  // merge consecutive text blocks
  const merged = [];
  for (const b of content) {
    const prev = merged[merged.length - 1];
    if (b.type === 'text' && prev?.type === 'text') prev.text += '\n' + b.text;
    else merged.push({ ...b });
  }
  if (!merged.some((b) => b.type !== 'text' || b.text.trim())) throw httpError(400, 'Message is empty');
  return { system, content: merged };
}
