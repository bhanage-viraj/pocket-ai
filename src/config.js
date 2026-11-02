// Central configuration. Everything comes from .env so the same code runs on the Mac and in Termux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const envFile = process.env.POCKET_ENV_FILE || path.resolve('.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const int = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const expandHome = (p) => (p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);

const botName = env.BOT_NAME || 'Pocket';

export const config = Object.freeze({
  botName,
  botNumber: digits(env.BOT_NUMBER),
  ownerNumbers: list(env.OWNER_NUMBERS).map(digits),
  allowedNumbers: list(env.ALLOWED_NUMBERS).map(digits),
  /** who gets replies in DMs: owner | allowlist | all */
  dmPolicy: (env.DM_POLICY || 'allowlist').toLowerCase(),
  /** group text triggers; {name} is replaced by BOT_NAME */
  groupTriggers: list(env.GROUP_TRIGGERS || '/ai,hey {name}').map((t) =>
    t.replaceAll('{name}', botName).toLowerCase(),
  ),

  llmUrl: (env.LLM_URL || 'http://127.0.0.1:8080').replace(/\/$/, ''),
  modelPath: expandHome(env.MODEL_PATH || '~/models/gemma-3-1b-it-Q4_K_M.gguf'),
  llmThreads: int(env.LLM_THREADS, 4),
  llmCtx: int(env.LLM_CTX, 4096),
  llmTimeoutMs: int(env.LLM_TIMEOUT_S, 120) * 1000,
  chatMaxTokens: int(env.CHAT_MAX_TOKENS, 300),
  chatTemperature: Number(env.CHAT_TEMPERATURE || 0.7),
  intentPrefilter: bool(env.INTENT_PREFILTER, true),

  historyTurns: int(env.HISTORY_TURNS, 6),
  groupContextLines: int(env.GROUP_CONTEXT_LINES, 12),
  rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 6),
  queueMax: int(env.QUEUE_MAX, 5),
  maxMessageAgeS: int(env.MAX_MESSAGE_AGE_S, 60),

  dataDir: path.resolve(expandHome(env.DATA_DIR || './data')),
  authDir: path.resolve(expandHome(env.AUTH_DIR || './auth')),
  logLevel: env.LOG_LEVEL || 'info',
});

export function isOwnerNumber(number) {
  return !!number && config.ownerNumbers.includes(digits(number));
}

export function isAllowedDm(number) {
  if (isOwnerNumber(number)) return true;
  if (config.dmPolicy === 'all') return true;
  if (config.dmPolicy === 'allowlist') return config.allowedNumbers.includes(digits(number));
  return false;
}
