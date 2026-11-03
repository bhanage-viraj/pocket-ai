// Central configuration. Everything comes from .env so the same code runs on the Mac and in Termux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const envFile = process.env.POCKET_ENV_FILE || path.resolve('.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const int = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const expandHome = (p) => (p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);

const botName = env.BOT_NAME || 'Pocket';

/** IANA timezone for reminders: TIMEZONE, else TZ, else Android's setting, else what Node thinks. */
function detectTimezone() {
  if (env.TIMEZONE || env.TZ) return env.TIMEZONE || env.TZ;
  try {
    const tz = execFileSync('getprop', ['persist.sys.timezone'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (tz) return tz;
  } catch { /* not Android */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

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
  chatMaxTokens: int(env.CHAT_MAX_TOKENS, 180),
  chatTemperature: Number(env.CHAT_TEMPERATURE || 0.7),
  intentPrefilter: bool(env.INTENT_PREFILTER, true),

  historyTurns: int(env.HISTORY_TURNS, 4),
  // the phone reads prompts at ~20 tokens/s: keep the history part of the prompt small
  historyMaxChars: int(env.HISTORY_MAX_CHARS, 1600),
  // ping the model every N seconds while idle so Android doesn't swap its weights out (0 = off)
  llmWarmS: int(env.LLM_WARM_S, 90),
  timezone: detectTimezone(),
  groupContextLines: int(env.GROUP_CONTEXT_LINES, 6),
  summaryMaxLines: int(env.SUMMARY_MAX_LINES, 40),

  // Mac bridge (Claude Code). Empty URL = /claude and /code are off.
  bridgeUrl: (env.MAC_BRIDGE_URL || '').replace(/\/$/, ''),
  bridgeToken: env.BRIDGE_TOKEN || '',
  claudePerHour: int(env.CLAUDE_PER_HOUR, 10),

  // Voice notes (whisper.cpp) and GIFs/stickers/photos (vision model). MEDIA=off disables both.
  media: bool(env.MEDIA, true),
  ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
  whisperBin: env.WHISPER_BIN || 'whisper-cli',
  whisperModel: expandHome(env.WHISPER_MODEL || '~/models/ggml-base-q5_1.bin'),
  whisperLang: env.WHISPER_LANG || 'auto',
  voiceMaxS: int(env.VOICE_MAX_S, 120),
  visionUrl: (env.VISION_URL || 'http://127.0.0.1:8081').replace(/\/$/, ''),
  mediaThreads: int(env.MEDIA_THREADS, 2),
  stickerFont: env.STICKER_FONT || '/system/fonts/DroidSans-Bold.ttf',
  tesseractBin: env.TESSERACT_BIN || 'tesseract',
  // live info in chat: weather, currency, news/web search. WEB=off disables it
  web: bool(env.WEB, true),
  braveApiKey: env.BRAVE_API_KEY || '',
  defaultCity: env.DEFAULT_CITY || '',
  // personal deadlines (portal screenshots): remind at this local time on the due day
  deadlineRemindAt: env.DEADLINE_REMIND_AT || '00:00',
  // morning brief to the owner (change with /brief 07:30)
  briefTime: env.BRIEF_TIME || '08:00',
  rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 6),
  queueMax: int(env.QUEUE_MAX, 5),
  maxMessageAgeS: int(env.MAX_MESSAGE_AGE_S, 60),
  lateReplyMaxS: int(env.LATE_REPLY_MAX_S, 86400),

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
