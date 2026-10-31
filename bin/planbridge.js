#!/usr/bin/env node
// PlanBridge CLI — run your Claude Code subscription as a local API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2).split('=')[0], a.includes('=') ? a.split('=').slice(1).join('=') : all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : [])),
);
if (flags.port) process.env.PLANBRIDGE_PORT = String(flags.port);
if (flags.host) process.env.PLANBRIDGE_HOST = String(flags.host);

const { config, ROOT, VERSION, HOME_DIR, keyFile } = await import('../src/config.js');
const PID_FILE = path.join(HOME_DIR, 'planbridge.pid');
const LOG_FILE = path.join(HOME_DIR, 'planbridge.log');
const BASE = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: String, r: String, y: String, d: String, b: String };
const ok = (m) => console.log(`  ${c.g('✔')} ${m}`);
const bad = (m) => console.log(`  ${c.r('✘')} ${m}`);
const warn = (m) => console.log(`  ${c.y('!')} ${m}`);

async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const commands = {
  async start() {
    if (await health()) {
      ok(`Already running at ${BASE}`);
      return;
    }
    if (flags.log) {
      const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      process.stdout.write = process.stderr.write = (s) => (out.write(s), true);
    }
    const { startServer } = await import('../src/server.js');
    await startServer().catch((e) => {
      console.error(`\n  ${c.r('✘')} ${e.message}\n`);
      process.exit(1);
    });
    fs.writeFileSync(PID_FILE, String(process.pid));
    const bye = () => {
      try {
        if (fs.readFileSync(PID_FILE, 'utf8') === String(process.pid)) fs.rmSync(PID_FILE);
      } catch {}
      process.exit(0);
    };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  },

  async stop() {
    let pid;
    try {
      pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    } catch {}
    if (!pid) return warn('Not running (no pid file).');
    try {
      process.kill(pid);
      fs.rmSync(PID_FILE, { force: true });
      ok(`Stopped (pid ${pid})`);
    } catch {
      fs.rmSync(PID_FILE, { force: true });
      warn('Process was not running; cleaned up pid file.');
    }
  },

  async status() {
    const h = await health();
    if (!h) {
      bad(`Not running at ${BASE}  ${c.d('→ planbridge start')}`);
      process.exitCode = 1;
      return;
    }
    ok(`Running at ${BASE}  ${c.d(`v${h.version} · model ${h.default_model} · ${h.active} active, ${h.queued} queued`)}`);
    try {
      const r = await fetch(`${BASE}/v1/limits`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
      const l = (await r.json()).rate_limit;
      for (const [k, w] of Object.entries(l?.unifiedWindows || {})) {
        const pct = Math.round((w.utilization || 0) * 100);
        const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
        console.log(`    ${k.padEnd(10)} ${bar} ${pct}%  ${c.d('resets ' + new Date(w.resetsAt * 1000).toLocaleString())}`);
      }
    } catch {}
  },

  async key() {
    if (flags.rotate) {
      fs.rmSync(keyFile(), { force: true });
      const { loadConfig } = await import('../src/config.js');
      const k = loadConfig().apiKey;
      console.log(k);
      warn('Key rotated — restart PlanBridge and update your apps.');
      return;
    }
    console.log(config.apiKey);
  },

  async env() {
    const lines = {
      PLANBRIDGE_URL: BASE,
      PLANBRIDGE_API_KEY: config.apiKey,
      '# OpenAI SDKs': null,
      OPENAI_BASE_URL: `${BASE}/v1`,
      OPENAI_API_KEY: config.apiKey,
      '# Anthropic SDKs': null,
      ANTHROPIC_BASE_URL: BASE,
      ANTHROPIC_AUTH_TOKEN: config.apiKey,
    };
    console.log("# Paste into your app's .env — not into your global shell profile.");
    for (const [k, v] of Object.entries(lines)) console.log(v === null ? `\n${k}` : `${k}=${v}`);
  },

  async open() {
    const url = `${BASE}/`;
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    ok(`Opening ${url}  ${c.d(`(API key: planbridge key)`)}`);
  },

  async doctor() {
    console.log(c.b('\n  PlanBridge doctor\n'));
    const major = Number(process.versions.node.split('.')[0]);
    const minor = Number(process.versions.node.split('.')[1]);
    major > 21 || (major === 21 && minor >= 7) ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — need 21.7+`);

    const v = spawnSync(config.claudeBin, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (v.status !== 0) {
      bad(`Claude Code not found ("${config.claudeBin}")  ${c.d('→ https://claude.com/claude-code')}`);
    } else {
      ok(`Claude Code ${v.stdout.trim()}`);
      const a = spawnSync(config.claudeBin, ['auth', 'status'], { encoding: 'utf8', windowsHide: true });
      try {
        const s = JSON.parse(a.stdout);
        if (!s.loggedIn) bad('Not logged in  → run `claude` and log in');
        else ok(`Logged in via ${s.authMethod}${s.subscriptionType ? ` (${s.subscriptionType} plan)` : ''}`);
        if (s.authMethod && s.authMethod !== 'claude.ai') warn('Not using a subscription login — requests will be billed to that API key/provider.');
      } catch {
        warn('Could not read `claude auth status`');
      }
    }
    if (process.env.ANTHROPIC_API_KEY) warn('ANTHROPIC_API_KEY is set: Claude Code may bill that key instead of your plan.');

    const h = await health();
    h ? ok(`Server running at ${BASE}`) : warn(`Server not running  ${c.d('→ planbridge start')}`);
    ok(`Data dir ${HOME_DIR}`);
    const skill = path.join(os.homedir(), '.claude', 'skills', 'planbridge', 'SKILL.md');
    fs.existsSync(skill) ? ok('Claude Code skill installed') : warn(`Skill not installed  ${c.d('→ planbridge skill install')}`);
    console.log();
  },

  async skill() {
    const sub = rest[0];
    const src = path.join(ROOT, 'skills', 'planbridge');
    const dest = flags.project ? path.join(process.cwd(), '.claude', 'skills', 'planbridge') : path.join(os.homedir(), '.claude', 'skills', 'planbridge');
    if (sub === 'install') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      ok(`Skill installed in ${dest}`);
      console.log(c.d('    Claude Code will now use PlanBridge when you ask it to add AI to an app.'));
    } else if (sub === 'uninstall') {
      fs.rmSync(dest, { recursive: true, force: true });
      ok(`Skill removed from ${dest}`);
    } else {
      console.log('Usage: planbridge skill install|uninstall [--project]');
    }
  },

  async autostart() {
    const sub = rest[0];
    const node = process.execPath;
    const script = path.join(ROOT, 'bin', 'planbridge.js');
    if (process.platform === 'win32') {
      const vbs = path.join(HOME_DIR, 'planbridge-start.vbs');
      if (sub === 'on') {
        fs.writeFileSync(vbs, `CreateObject("Wscript.Shell").Run """${node}"" ""${script}"" start --log", 0, False\r\n`);
        const r = spawnSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'PlanBridge', '/TR', `wscript.exe "${vbs}"`], { encoding: 'utf8' });
        r.status === 0 ? ok('PlanBridge will start when you log in (Task Scheduler: "PlanBridge")') : bad(r.stderr || r.stdout);
      } else if (sub === 'off') {
        spawnSync('schtasks', ['/Delete', '/F', '/TN', 'PlanBridge'], { encoding: 'utf8' });
        fs.rmSync(vbs, { force: true });
        ok('Autostart removed');
      } else console.log('Usage: planbridge autostart on|off');
    } else if (process.platform === 'darwin') {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.planbridge.plist');
      if (sub === 'on') {
        fs.mkdirSync(path.dirname(plist), { recursive: true });
        fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.planbridge</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string><key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict></plist>\n`);
        spawnSync('launchctl', ['unload', plist]);
        const r = spawnSync('launchctl', ['load', plist], { encoding: 'utf8' });
        r.status === 0 ? ok('PlanBridge will start at login (launchd: dev.planbridge)') : bad(r.stderr);
      } else if (sub === 'off') {
        spawnSync('launchctl', ['unload', plist]);
        fs.rmSync(plist, { force: true });
        ok('Autostart removed');
      } else console.log('Usage: planbridge autostart on|off');
    } else {
      const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'planbridge.service');
      if (sub === 'on') {
        fs.mkdirSync(path.dirname(unit), { recursive: true });
        fs.writeFileSync(unit, `[Unit]\nDescription=PlanBridge\n\n[Service]\nExecStart=${node} ${script} start\nEnvironment=PATH=${process.env.PATH}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
        spawnSync('systemctl', ['--user', 'daemon-reload']);
        const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'planbridge'], { encoding: 'utf8' });
        r.status === 0 ? ok('PlanBridge enabled (systemd --user planbridge)') : bad(r.stderr);
      } else if (sub === 'off') {
        spawnSync('systemctl', ['--user', 'disable', '--now', 'planbridge']);
        fs.rmSync(unit, { force: true });
        ok('Autostart removed');
      } else console.log('Usage: planbridge autostart on|off');
    }
  },

  async version() {
    console.log(VERSION);
  },

  async help() {
    console.log(`
  ${c.b('PlanBridge')} v${VERSION} — use your Claude Code subscription as a local, OpenAI/Anthropic-compatible API.
  ${c.d('Personal use only: it runs on your machine, for your own apps.')}

  ${c.b('Usage')}  planbridge <command>

    start [--port N]        start the server (foreground)
    stop                    stop a running server
    status                  is it running? + plan usage bars
    open                    open the playground in your browser
    key [--rotate]          print (or regenerate) your local API key
    env                     print env vars to paste into your apps
    doctor                  check Node, Claude Code login, server, skill
    skill install           teach Claude Code to wire PlanBridge into apps you build
    autostart on|off        start PlanBridge automatically at login

  Data & settings: ${HOME_DIR}  ${c.d('(.env, api-key.txt, sessions.json)')}
`);
  },
};

commands['--help'] = commands['-h'] = commands.help;
commands['--version'] = commands['-v'] = commands.version;

if (!commands[cmd]) {
  console.log(`Unknown command: ${cmd}`);
  await commands.help();
  process.exit(1);
}
await commands[cmd]();
