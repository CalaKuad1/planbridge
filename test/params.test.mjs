import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { pickModel, pickEffort, pickSchema, validateSessionId } = await import('../src/params.js');

test('pickModel maps aliases, full ids and foreign names', () => {
  assert.equal(pickModel('opus', 'sonnet'), 'opus');
  assert.equal(pickModel('Claude-Haiku-5-5', 'sonnet'), 'Claude-Haiku-5-5');
  assert.equal(pickModel('anthropic/haiku', 'sonnet'), 'haiku');
  assert.equal(pickModel('gpt-4o', 'sonnet'), 'sonnet');
  assert.equal(pickModel(undefined, 'sonnet'), 'sonnet');
});

test('pickEffort accepts OpenAI, Anthropic and thinking budgets', () => {
  assert.equal(pickEffort({ reasoning_effort: 'HIGH' }), 'high');
  assert.equal(pickEffort({ reasoning_effort: 'minimal' }), 'low');
  assert.equal(pickEffort({ output_config: { effort: 'max' } }), 'max');
  assert.equal(pickEffort({ thinking: { type: 'enabled', budget_tokens: 2000 } }), 'low');
  assert.equal(pickEffort({ thinking: { type: 'enabled', budget_tokens: 20000 } }), 'high');
  assert.equal(pickEffort({}, 'medium'), 'medium');
  assert.equal(pickEffort({}), '');
  assert.throws(() => pickEffort({ reasoning_effort: 'turbo' }), /Invalid effort/);
});

test('pickSchema handles json_schema, json_object and text', () => {
  const schema = { type: 'object' };
  assert.deepEqual(pickSchema({ response_format: { type: 'json_schema', json_schema: { schema } } }).schema, schema);
  assert.deepEqual(pickSchema({ output_config: { format: { type: 'json_schema', schema } } }).schema, schema);
  assert.match(pickSchema({ response_format: { type: 'json_object' } }).extra, /JSON/);
  assert.equal(pickSchema({}).schema, null);
  assert.throws(() => pickSchema({ response_format: { type: 'json_schema', json_schema: {} } }), /required/);
});

test('validateSessionId', () => {
  assert.equal(validateSessionId('chat-1:a.b_c'), 'chat-1:a.b_c');
  assert.equal(validateSessionId(undefined), null);
  assert.throws(() => validateSessionId('../etc/passwd'));
});
