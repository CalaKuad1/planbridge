# PlanBridge integration snippets

All snippets read `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` from the environment, so the same code runs on PlanBridge (personal) or on Anthropic's API (production).

| | PlanBridge (personal) | Anthropic API (deployed / other users) |
|---|---|---|
| `AI_BASE_URL` | `http://127.0.0.1:3456/v1` | `https://api.anthropic.com/v1/` |
| `AI_API_KEY` | output of `planbridge key` | Console API key (`sk-ant-…`) |
| `AI_MODEL` | `sonnet` / `haiku` / `opus` | full id, e.g. `claude-sonnet-5-5` |

Note: `session_id` is a PlanBridge extension. Code that must also run on the Anthropic API should send the full `messages` history instead.

---

## Node.js (official `openai` package)

```js
import OpenAI from 'openai';
const ai = new OpenAI({ baseURL: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY });
const MODEL = process.env.AI_MODEL || 'sonnet';

// one-shot
const r = await ai.chat.completions.create({
  model: MODEL,
  messages: [
    { role: 'system', content: 'You summarise support tickets in 2 bullet points.' },
    { role: 'user', content: ticketText },
  ],
});
console.log(r.choices[0].message.content);

// streaming
const stream = await ai.chat.completions.create({ model: MODEL, stream: true, messages });
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');

// structured output
const j = await ai.chat.completions.create({
  model: 'haiku',
  messages: [{ role: 'user', content: `Extract the invoice fields:\n${text}` }],
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'invoice', schema: { type: 'object', properties: { total: { type: 'number' }, date: { type: 'string' } }, required: ['total', 'date'] } },
  },
});
const invoice = JSON.parse(j.choices[0].message.content);

// image (vision)
import fs from 'node:fs';
const b64 = fs.readFileSync('photo.jpg').toString('base64');
await ai.chat.completions.create({
  model: MODEL,
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe this photo' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
  ] }],
});
```

Zero-dependency alternative: `fetch(process.env.AI_BASE_URL + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.AI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages }) })`.

## Python (official `openai` package)

```python
import os
from openai import OpenAI

ai = OpenAI(base_url=os.environ["AI_BASE_URL"], api_key=os.environ["AI_API_KEY"])
MODEL = os.environ.get("AI_MODEL", "sonnet")

r = ai.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "Hello"}])
print(r.choices[0].message.content)

# streaming
for chunk in ai.chat.completions.create(model=MODEL, messages=msgs, stream=True):
    print(chunk.choices[0].delta.content or "", end="", flush=True)

# PlanBridge memory (personal only): send just the new message each turn
r = ai.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": text}],
                               extra_body={"session_id": "notes-assistant"})

# PDF
import base64
pdf = base64.b64encode(open("report.pdf", "rb").read()).decode()
ai.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": [
    {"type": "file", "file": {"filename": "report.pdf", "file_data": f"data:application/pdf;base64,{pdf}"}},
    {"type": "text", "text": "Key findings in 5 bullets"},
]}])
```

## Next.js — API route that streams to the browser

```ts
// app/api/chat/route.ts
import OpenAI from 'openai';
const ai = new OpenAI({ baseURL: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY });

export async function POST(req: Request) {
  const { messages } = await req.json();
  const stream = await ai.chat.completions.create({
    model: process.env.AI_MODEL || 'sonnet',
    stream: true,
    messages: [{ role: 'system', content: 'You are the assistant of this app. Be concise.' }, ...messages],
  });
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) {
      try { for await (const ch of stream) c.enqueue(enc.encode(ch.choices[0]?.delta?.content || '')); }
      finally { c.close(); }
    },
  }), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
```

```tsx
// client component
const res = await fetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages }) });
const reader = res.body!.getReader(); const dec = new TextDecoder(); let text = '';
for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); setReply(text); }
```

If the project already uses the Vercel AI SDK: `createOpenAI({ baseURL: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY })` and use `.chat(model)` (chat-completions mode).

## Plain HTML page (local, no build step)

```html
<script src="http://127.0.0.1:3456/sdk.js"></script>
<script>
  const ai = new PlanBridge({ apiKey: 'PASTE_KEY', model: 'sonnet', system: 'You are a friendly cooking helper.' });
  const chat = ai.chat();                       // remembers the conversation
  async function send(text) {
    if (!(await ai.health())) return alert('Start PlanBridge: planbridge start');
    await chat.send(text, { onText: (_, all) => (out.textContent = all) });
  }
  // also: ai.ask(text, { images: [fileInput.files[0]] }), ai.json(prompt, schema), ai.limits()
</script>
```

The key is visible in the page source, so this is only for pages on the user's own machine.

## Anthropic SDK (if the project already uses it)

```js
import Anthropic from '@anthropic-ai/sdk';
const claude = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL /* http://127.0.0.1:3456 */, apiKey: process.env.ANTHROPIC_API_KEY /* planbridge key */ });
const msg = await claude.messages.create({ model: 'sonnet', max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] });
```

```python
import anthropic
claude = anthropic.Anthropic(base_url="http://127.0.0.1:3456", api_key=os.environ["PLANBRIDGE_API_KEY"])
```

## Shell / automation

```bash
jq -n --arg diff "$(git diff --staged | head -c 20000)" \
  '{model:"haiku", messages:[{role:"user", content:("Write a one-line commit message for:\n" + $diff)}]}' \
| curl -s http://127.0.0.1:3456/v1/chat/completions \
    -H "Authorization: Bearer $(planbridge key)" -H "Content-Type: application/json" -d @- \
| jq -r '.choices[0].message.content'
```

Works with no-code tools too (n8n, Open WebUI, LibreChat, Continue, Raycast…): choose "OpenAI-compatible", base URL `http://127.0.0.1:3456/v1`, key from `planbridge key`.
