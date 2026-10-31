import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const HOME_DIR = path.resolve(process.env.PLANBRIDGE_HOME || path.join(os.homedir(), '.planbridge'));

// Settings: ~/.planbridge/.env, then ./.env (later files do not override earlier ones or real env vars)
for (const f of [path.join(HOME_DIR, '.env'), path.join(process.cwd(), '.env')]) {
  try {
    process.loadEnvFile(f);
  } catch {}
}

const env = process.env;
const int = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function loadConfig() {
  const dataDir = HOME_DIR;
  const workspaceDir = path.join(dataDir, 'workspace');
  const tmpDir = path.join(dataDir, 'tmp');
  for (const d of [dataDir, workspaceDir, tmpDir]) fs.mkdirSync(d, { recursive: true });

  return {
    host: env.PLANBRIDGE_HOST || env.HOST || '127.0.0.1',
    port: int(env.PLANBRIDGE_PORT || env.PORT, 3456),
    apiKey: resolveApiKey(dataDir),
    claudeBin: env.CLAUDE_BIN || 'claude',
    defaultModel: env.DEFAULT_MODEL || 'sonnet',
    defaultEffort: env.DEFAULT_EFFORT || '',
    defaultSystemPrompt:
      env.DEFAULT_SYSTEM_PROMPT ??
      "You are a helpful assistant embedded in the user's own app. Answer clearly and concisely, in the user's language.",
    maxConcurrent: int(env.MAX_CONCURRENT, 2),
    maxQueue: int(env.MAX_QUEUE, 20),
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 30),
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 300000),
    maxBodyBytes: int(env.MAX_BODY_MB, 25) * 1024 * 1024,
    warmPool: int(env.WARM_POOL, 2), //            pre-started CLI processes (~240 MB each); 0 disables
    warmTtlMs: int(env.WARM_TTL_MS, 300000), //    idle warm processes are closed after this
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 30), // conversations idle longer than this are deleted; 0 keeps them
    corsOrigin: env.CORS_ORIGIN ?? '*',
    dataDir,
    workspaceDir,
    tmpDir,
  };
}

export function keyFile(dataDir = HOME_DIR) {
  return path.join(dataDir, 'api-key.txt');
}

function resolveApiKey(dataDir) {
  if (env.PLANBRIDGE_API_KEY || env.API_KEY) return env.PLANBRIDGE_API_KEY || env.API_KEY;
  const file = keyFile(dataDir);
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (k) return k;
  } catch {}
  const k = 'pb-' + crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, k + '\n', { mode: 0o600 });
  return k;
}

export const config = loadConfig();
