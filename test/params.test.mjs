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

test('resolveWindowsBin finds claude.exe, or the target of an npm claude.cmd shim', async () => {
  const { resolveWindowsBin } = await import('../src/claude.js');
  const r = String.raw;
  // the exact shim npm writes for @anthropic-ai/claude-code
  const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
    r`"%dp0%\..\@anthropic-ai\claude-code\bin\claude.exe"   %*` + '\r\n';
  const target = r`C:\@anthropic-ai\claude-code\bin\claude.exe`;
  const files = { [r`C:\npm\claude.cmd`]: shim, [target]: '', [r`C:\native\claude.exe`]: '' };
  const exists = (f) => f in files;
  const read = (f) => files[f];
  // npm shim found on PATH
  assert.equal(resolveWindowsBin('claude', r`C:\nothing;C:\npm`, exists, read), target);
  // a native .exe earlier on PATH wins
  assert.equal(resolveWindowsBin('claude', r`C:\native;C:\npm`, exists, read), r`C:\native\claude.exe`);
  // explicit .cmd path
  assert.equal(resolveWindowsBin(r`C:\npm\claude.cmd`, '', exists, read), target);
  // explicit paths and unknown names are left alone
  assert.equal(resolveWindowsBin(r`D:\tools\claude.exe`, r`C:\npm`, exists, read), r`D:\tools\claude.exe`);
  assert.equal(resolveWindowsBin('claude', r`C:\empty`, exists, read), 'claude');
});
