// Checks that the installed Claude Code CLI still accepts every argument
// combination PlanBridge uses. Needs no login: with an empty stdin the CLI
// exits before calling the API, but it still validates its options.
//
//   node scripts/check-cli-compat.mjs        (exit code 1 on incompatibility)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.PLANBRIDGE_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'pb-compat-'));
const { buildArgs, claudeCommand } = await import('../src/claude.js');
const [cmd, pre] = claudeCommand();

const version = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.error('claude --version failed:', version.stderr || version.error?.message);
  process.exit(1);
}
console.log(`Claude Code ${version.stdout.trim()}`);

const promptFile = path.join(process.env.PLANBRIDGE_HOME, 'system-prompt.txt');
fs.writeFileSync(promptFile, 'You are a test.');
const uuid = '00000000-0000-4000-8000-000000000000';
const cases = {
  stateless: { model: 'haiku' },
  'system prompt + effort': { model: 'sonnet', effort: 'high', systemPrompt: 'x' },
  'json schema': { model: 'haiku', jsonSchema: { type: 'object', properties: { a: { type: 'string' } } } },
  'new session': { model: 'haiku', session: { mode: 'new', id: uuid } },
  'resume session': { model: 'haiku', session: { mode: 'resume', id: uuid } },
};

let failed = 0;
for (const [name, opts] of Object.entries(cases)) {
  const args = buildArgs(opts, opts.systemPrompt ? promptFile : null);
  const r = spawnSync(cmd, [...pre, ...args], { input: '', encoding: 'utf8', timeout: 60000, cwd: process.env.PLANBRIDGE_HOME });
  const out = `${r.stderr}\n${r.stdout}`;
  const bad = /unknown option|unknown argument|invalid (option|argument|choice)|error: option|too many arguments/i.exec(out);
  if (bad) {
    failed++;
    console.log(`✘ ${name}: ${out.trim().split('\n').find((l) => bad[0] && l.toLowerCase().includes(bad[0].toLowerCase().split(' ')[0])) || out.trim().slice(0, 300)}`);
  } else {
    console.log(`✔ ${name}`);
  }
}
if (failed) {
  console.log(`\n${failed} argument set(s) rejected — PlanBridge needs an update for this Claude Code version.`);
  process.exit(1);
}
console.log('\nAll argument sets accepted.');
