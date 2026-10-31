// Maps your app's conversation ids to Claude Code session ids.
import fs from 'node:fs';
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
  saveTimer = setTimeout(() => {
    fs.writeFile(FILE + '.tmp', JSON.stringify(store, null, 2), (err) => {
      if (!err) fs.rename(FILE + '.tmp', FILE, () => {});
    });
  }, 200);
}

const locks = new Map();

export const sessions = {
  get: (id) => store[id] || null,
  list: () => Object.entries(store).map(([id, v]) => ({ id, ...v })),
  newId: () => 'conv_' + crypto.randomBytes(12).toString('hex'),
  /** Creates the entry if needed. Returns {claudeSessionId, isNew} */
  open(id) {
    if (store[id]?.started) return { claudeSessionId: store[id].claudeSessionId, isNew: false };
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
  remove(id) {
    const existed = !!store[id];
    delete store[id];
    save();
    return existed;
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
