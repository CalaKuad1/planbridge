import OpenAI from 'openai';

const ai = new OpenAI({
  baseURL: 'http://127.0.0.1:3456/v1',
  apiKey: process.env.PLANBRIDGE_API_KEY,
});

const stream = await ai.chat.completions.create({
  model: 'sonnet',
  stream: true,
  messages: [{ role: 'user',
    content: 'Write a haiku about localhost' }],
});

for await (const c of stream)
  process.stdout.write(c.choices[0]?.delta?.content || '');
