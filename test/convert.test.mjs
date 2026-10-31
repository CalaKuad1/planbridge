import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { convertMessages } = await import('../src/convert.js');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('single user message', async () => {
  const r = await convertMessages([{ role: 'user', content: 'hi' }]);
  assert.equal(r.system, '');
  assert.deepEqual(r.content, [{ type: 'text', text: 'hi' }]);
});

test('system + developer messages become the system prompt', async () => {
  const r = await convertMessages([
    { role: 'system', content: 'A' },
    { role: 'developer', content: [{ type: 'text', text: 'B' }] },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(r.system, 'A\n\nB');
});

test('history is wrapped, onlyNew drops it', async () => {
  const msgs = [
    { role: 'user', content: 'my name is Ana' },
    { role: 'assistant', content: 'hi Ana' },
    { role: 'user', content: 'name?' },
  ];
  const full = await convertMessages(msgs);
  assert.equal(full.content.length, 1);
  assert.match(full.content[0].text, /<conversation_history>[\s\S]*my name is Ana[\s\S]*hi Ana[\s\S]*<\/conversation_history>[\s\S]*name\?$/);
  const onlyNew = await convertMessages(msgs, { onlyNew: true });
  assert.deepEqual(onlyNew.content, [{ type: 'text', text: 'name?' }]);
});

test('image_url data URL -> image block', async () => {
  const r = await convertMessages([{ role: 'user', content: [
    { type: 'text', text: 'what?' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
  ] }]);
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].source.media_type, 'image/png');
  assert.equal(r.content[1].source.data, PNG);
});

test('file parts: pdf -> document, text -> inline text, unknown -> 415', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  const r = await convertMessages([{ role: 'user', content: [
    { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${pdf}` } },
    { type: 'file', file: { filename: 'n.txt', file_data: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}` } },
  ] }]);
  assert.equal(r.content[0].type, 'document');
  assert.match(r.content[1].text, /<file name="n.txt">\nhello/);
  await assert.rejects(
    convertMessages([{ role: 'user', content: [{ type: 'file', file: { filename: 'x.bin', file_data: 'data:application/zip;base64,UEsDBA==' } }] }]),
    (e) => e.status === 415,
  );
});

test('native Anthropic blocks pass through', async () => {
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
  const r = await convertMessages([{ role: 'user', content: [block, { type: 'text', text: 'x' }] }]);
  assert.deepEqual(r.content[0], block);
});

test('rejects empty or assistant-last conversations', async () => {
  await assert.rejects(convertMessages([]), (e) => e.status === 400);
  await assert.rejects(convertMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), (e) => e.status === 400);
});
