// Morning brief: one private message to the owner every day at BRIEF_TIME (owner's timezone):
// deadlines due today / this week and today's reminders. /brief = now, /brief off|on|07:30 = settings.
import { formatWhen } from '../util/when.js';
import { log } from '../util/log.js';

export function createSettings(db) {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  return {
    get: (k, d = null) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d,
    set: (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),
  };
}

const localParts = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};

export function createBrief({ db, config, io, deadlines, settings }) {
  const ownerChat = () => settings.get('owner_chat') || (config.ownerNumbers[0] ? `${config.ownerNumbers[0]}@s.whatsapp.net` : null);

  function text(now = Date.now()) {
    const tz = config.timezone;
    const chat = ownerChat();
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(now);
    const out = [`☀️ *Good morning!* ${day}`];

    const week = deadlines ? deadlines.upcoming(chat, now + 7 * 86_400_000) : [];
    const today = localParts(now, tz).date;
    const dueToday = week.filter((d) => localParts(d.due_at, d.tz).date === localParts(now, d.tz).date);
    const later = week.filter((d) => !dueToday.includes(d));
    if (dueToday.length) out.push('', `📚 *Due today*`, ...dueToday.map(deadlines.line));
    if (later.length) {
      out.push('', '🗓️ *This week*');
      for (const d of later) out.push(`${formatWhen(d.due_at, now, d.tz).replace(/ \d.*$/, '')}: ${deadlines.line(d).slice(2)}`);
    }

    const hasReminders = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders'").get();
    const rem = hasReminders
      ? db.prepare('SELECT * FROM reminders WHERE sent_at IS NULL AND (chat_id = ? OR sender = ?) AND due_at > ? AND due_at < ? ORDER BY due_at')
        .all(chat, config.ownerNumbers[0] ?? '', now, now + 86_400_000).filter((r) => localParts(r.due_at, tz).date === today)
      : [];
    if (rem.length) out.push('', '⏰ *Reminders today*', ...rem.map((r) => `${formatWhen(r.due_at, now, tz).replace(/^today /, '')}: ${r.what.split('\n')[0]}`));

    if (!dueToday.length && !later.length && !rem.length) out.push('', 'Nothing due this week 🎉');
    return out.join('\n');
  }

  async function tick(now = Date.now()) {
    if (settings.get('brief', 'on') !== 'on') return;
    const { date, hm } = localParts(now, config.timezone);
    const at = settings.get('brief_time', config.briefTime);
    if (hm < at || settings.get('brief_last') === date) return;
    const chat = ownerChat();
    if (!chat) return;
    try {
      await io.sendText(chat, text(now));
      settings.set('brief_last', date);
    } catch (err) {
      log.warn(`morning brief not sent yet: ${err.message}`);
    }
  }

  return { tick, text, ownerChat };
}
