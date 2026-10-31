// Maps your app's conversation ids to Claude Code session ids, and cleans up
// old conversations (including Claude Code's transcript files for them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'sessions.json');
let store = {};
try {
  store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
  saveTimer.unref?.();
}
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(store, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch {}
}
process.on('exit', () => saveTimer && flush());

/** Where Claude Code keeps transcripts for sessions run in our workspace. */
export function transcriptDir() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeDir, 'projects', config.workspaceDir.replace(/[^a-zA-Z0-9]/g, '-'));
}

function deleteTranscript(claudeSessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(claudeSessionId || '')) return; // only ever delete our own UUID-named files
  fs.rm(path.join(transcriptDir(), `${claudeSessionId}.jsonl`), { force: true }, () => {});
  fs.rm(path.join(transcriptDir(), claudeSessionId), { recursive: true, force: true }, () => {});
}

const locks = new Map();

export const sessions = {
  get: (id) => store[id] || null,
  list: () => Object.entries(store).map(([id, v]) => ({ id, ...v })),
  newId: () => 'conv_' + crypto.randomBytes(12).toString('hex'),

  /** Creates the entry if needed. Returns {claudeSessionId, isNew} */
  open(id) {
    if (store[id]?.started) return { claudeSessionId: store[id].claudeSessionId, isNew: false };
    if (store[id]?.claudeSessionId) deleteTranscript(store[id].claudeSessionId); // leftover of a failed first turn
    // fresh UUID until a turn completes (a previous attempt may have failed half-way)
    const claudeSessionId = crypto.randomUUID();
    store[id] = { claudeSessionId, started: false, createdAt: new Date().toISOString(), turns: 0 };
    return { claudeSessionId, isNew: true };
  },

  /** Records a completed turn */
  touch(id, model) {
    if (!store[id]) return;
    Object.assign(store[id], { started: true, updatedAt: new Date().toISOString(), turns: (store[id].turns || 0) + 1, model });
    save();
  },

  /** Forgets a conversation and deletes its transcript. */
  remove(id) {
    const s = store[id];
    if (!s) return false;
    deleteTranscript(s.claudeSessionId);
    delete store[id];
    save();
    return true;
  },

  /** Removes conversations idle for longer than SESSION_TTL_DAYS. Returns how many. */
  prune(now = Date.now()) {
    if (!(config.sessionTtlDays > 0)) return 0;
    const cutoff = now - config.sessionTtlDays * 86400000;
    let n = 0;
    for (const [id, s] of Object.entries(store)) {
      if (Date.parse(s.updatedAt || s.createdAt || 0) < cutoff) {
        this.remove(id);
        n++;
      }
    }
    return n;
  },

  /** Serialises turns within one conversation */
  async withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const chain = prev.then(() => mine);
    locks.set(id, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(id) === chain) locks.delete(id);
    }
  },
};
