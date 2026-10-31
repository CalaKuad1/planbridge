// Pure request-parameter helpers (no I/O) — unit tested in test/.
import { MODELS, EFFORTS } from './config.js';

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** "sonnet" | "claude-opus-5-5" | "gpt-4o" -> CLI model argument */
export function pickModel(m, fallback) {
  if (!m || typeof m !== 'string') return fallback;
  const s = m.toLowerCase();
  if (s.startsWith('claude-')) return m;
  return MODELS.find((a) => s === a || s.includes(a)) || fallback;
}

/** OpenAI reasoning_effort / Anthropic output_config.effort / thinking.budget_tokens -> --effort */
export function pickEffort(body, fallback = '') {
  let e = body.reasoning_effort || body.effort || body.reasoning?.effort || body.output_config?.effort || '';
  if (!e && body.thinking?.type === 'enabled' && body.thinking.budget_tokens) {
    const b = body.thinking.budget_tokens;
    e = b < 4000 ? 'low' : b < 16000 ? 'medium' : b < 32000 ? 'high' : 'max';
  }
  e = String(e || fallback || '').toLowerCase();
  if (!e) return '';
  if (e === 'minimal' || e === 'none') return 'low';
  if (!EFFORTS.includes(e)) throw httpError(400, `Invalid effort "${e}" (use ${EFFORTS.join(', ')})`);
  return e;
}

/** OpenAI response_format / Anthropic output_config.format -> { schema, extra } */
export function pickSchema(body) {
  const rf = body.response_format || body.output_config?.format;
  if (!rf || rf.type === 'text') return { schema: null, extra: '' };
  if (rf.type === 'json_schema') {
    const schema = rf.json_schema?.schema || rf.schema;
    if (!schema) throw httpError(400, 'json_schema.schema is required');
    return { schema, extra: '' };
  }
  if (rf.type === 'json_object') {
    return { schema: null, extra: 'Reply with a single valid JSON object only — no prose, no code fences.' };
  }
  return { schema: null, extra: '' };
}

export function validateSessionId(id) {
  if (id && !/^[\w.:-]{1,128}$/.test(id)) throw httpError(400, 'session_id: letters, digits, _ . : - only (max 128)');
  return id || null;
}
