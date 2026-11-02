// Tiny leveled logger for our own output (Baileys gets its own pino instance).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 19);
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(ts, level.toUpperCase().padEnd(5), ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};
