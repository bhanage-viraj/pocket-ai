// Personal deadlines: send a screenshot of your course portal ("Nov 5 · Graded Quiz … · Course • Due at
// 11:59 PM IST") -> Tesseract OCR -> plain-code parser -> stored deadlines + one reminder per due day,
// sent at the start of that day, listing only what's not done yet. Also feeds the morning brief.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { zonedToUtc, formatWhen } from '../util/when.js';
import { MediaUnavailableError } from '../media/index.js';
import { log } from '../util/log.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const TZ_ALIASES = { ist: 'Asia/Kolkata', utc: 'UTC', gmt: 'UTC', wita: 'Asia/Makassar', wib: 'Asia/Jakarta', pst: 'America/Los_Angeles', est: 'America/New_York' };
const HEADER = new RegExp(`^\\W*${MONTH_RE}\\s*(\\d{1,2})(?:st|nd|rd|th)?\\W*$`, 'i');
const DUE = /\bdue\b\s*(?:at|by|on)?\s*(?:(\w+\.?\s*\d{1,2}),?\s*)?(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i;

/**
 * OCR text -> [{title, course, month, day, hour, minute, tz}]. Pure function (tested).
 * Works on portal lists like Coursera/IITM/Scaler: date header, then "title" line(s), then "course • Due at …".
 */
export function parseDeadlines(text, { defaultTz = 'UTC' } = {}) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  let date = null;
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADER.exec(line);
    if (h) {
      date = { month: MONTHS.indexOf(h[1].slice(0, 3).toLowerCase()) + 1, day: +h[2] };
      pending = [];
      continue;
    }
    const due = DUE.exec(line);
    if (!due) {
      pending.push(line);
      continue;
    }
    let d = date;
    if (due[1]) {
      const m = new RegExp(`${MONTH_RE}\\s*(\\d{1,2})`, 'i').exec(due[1]);
      if (m) d = { month: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, day: +m[2] };
    }
    if (!d) { pending = []; continue; }
    let hour = +due[2];
    const ap = (due[4] || '').toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    const tzWord = (/\b(IST|UTC|GMT|WITA|WIB|PST|EST)\b/i.exec(line) || /^\W*(IST|UTC|GMT|WITA|WIB|PST|EST)\W*$/i.exec(lines[i + 1] || ''))?.[1];
    let course = line.slice(0, due.index).replace(/[\s«»•·|,:-]+$/, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    // a long course name wrapped by OCR ("…Programmin" / "g « Due at …"): glue the fragment back on
    if (course.length < 4 && pending.length > 1) course = pending.pop() + (/^[a-z]/.test(course) ? '' : ' ') + course;
    // OCR reads the little list icon as "B", "@", "©"…: drop a lone leading symbol/letter before a capitalised word
    const title = pending.join(' ').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').replace(/^[BOo0®©€@]\s+(?=[A-Z])/, '').trim();
    out.push({
      title: title || course || 'Deadline', course: title ? course : '',
      month: d.month, day: d.day, hour, minute: +due[3],
      tz: tzWord ? TZ_ALIASES[tzWord.toLowerCase()] : defaultTz,
    });
    pending = [];
    if (tzWord && !DUE.test(lines[i + 1] || '') && /^\W*(IST|UTC|GMT|WITA|WIB|PST|EST)\W*$/i.test(lines[i + 1] || '')) i++;
  }
  return out;
}

/** Month/day -> the next such date (this year, or next year if it's well past). */
function resolveYear({ month, day, hour, minute, tz }, now) {
  const y = new Date(now).getUTCFullYear();
  for (const year of [y, y + 1]) {
    const at = zonedToUtc(year, month, day, hour, minute, tz);
    if (at > now - 60 * 86_400_000) return at; // up to 60 days in the past still counts as "this year"
  }
  return zonedToUtc(y + 1, month, day, hour, minute, tz);
}

export function createDeadlines({ db, config, io }) {
  db.exec(`CREATE TABLE IF NOT EXISTS deadlines (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      course TEXT,
      due_at INTEGER NOT NULL,
      tz TEXT NOT NULL,
      notify_at INTEGER NOT NULL,
      notified_at INTEGER,
      done_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deadlines_unique ON deadlines(chat_id, title, course, due_at);`);

  const tmpDir = path.join(config.dataDir, 'tmp');
  const remindAt = /^(\d{1,2}):(\d{2})$/.exec(config.deadlineRemindAt || '00:00') || [0, '0', '0'];

  function ocr(buffer) {
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `ocr-${crypto.randomBytes(4).toString('hex')}.png`);
    fs.writeFileSync(file, buffer);
    return new Promise((resolve, reject) => {
      execFile(config.tesseractBin, [file, '-', '--psm', '4'], { timeout: 60_000, maxBuffer: 2 << 20 }, (err, stdout) => {
        fs.rm(file, { force: true }, () => {});
        if (err?.code === 'ENOENT') reject(new MediaUnavailableError('tesseract not installed'));
        else if (err) reject(err);
        else resolve(String(stdout));
      });
    });
  }

  /** Store parsed items for a chat. Returns {added, skipped, past}. */
  function add(chatId, items, now = Date.now()) {
    const ins = db.prepare(`INSERT OR IGNORE INTO deadlines (chat_id, title, course, due_at, tz, notify_at, created_at)
      VALUES (?,?,?,?,?,?,?)`);
    const added = [];
    let skipped = 0;
    let past = 0;
    for (const it of items) {
      const due = resolveYear(it, now);
      if (due < now) { past++; continue; }
      const y = Number(new Intl.DateTimeFormat('en-US', { timeZone: it.tz, year: 'numeric' }).format(due));
      let notify = zonedToUtc(y, it.month, it.day, +remindAt[1], +remindAt[2], it.tz); // start of the due day
      if (notify < now) notify = now; // already that day: remind right away
      const r = ins.run(chatId, it.title, it.course || '', due, it.tz, notify, now);
      if (r.changes) added.push({ ...it, due });
      else skipped++;
    }
    return { added, skipped, past };
  }

  const upcoming = (chatId, untilMs) =>
    db.prepare('SELECT * FROM deadlines WHERE chat_id = ? AND done_at IS NULL AND due_at > ? AND due_at <= ? ORDER BY due_at, id')
      .all(chatId, Date.now(), untilMs);

  const line = (d) => `• ${d.course ? `*${d.course}*: ` : ''}${d.title}`;

  /** One message per chat & due day, at the start of the day, listing the not-done items. */
  async function tick(now = Date.now()) {
    const due = db.prepare('SELECT * FROM deadlines WHERE notified_at IS NULL AND done_at IS NULL AND notify_at <= ? AND due_at > ? ORDER BY chat_id, due_at').all(now, now);
    const groups = new Map();
    for (const d of due) {
      const key = `${d.chat_id}|${new Date(d.due_at).toISOString().slice(0, 10)}`;
      groups.set(key, [...(groups.get(key) || []), d]);
    }
    for (const items of groups.values()) {
      const first = items[0];
      const time = new Intl.DateTimeFormat('en-US', { timeZone: first.tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(first.due_at);
      try {
        await io.sendText(first.chat_id, `📚 *Due TODAY* (by ${time})\n${items.map(line).join('\n')}\n\nMark done: /deadlines done <id>`);
        const mark = db.prepare('UPDATE deadlines SET notified_at = ? WHERE id = ?');
        for (const d of items) mark.run(Date.now(), d.id);
      } catch (err) {
        log.warn(`deadline reminder not sent yet: ${err.message}`);
      }
    }
  }

  return {
    ocr,
    add,
    upcoming,
    tick,
    line,
    /** "/deadlines" text */
    listText(chatId) {
      const rows = upcoming(chatId, Date.now() + 120 * 86_400_000);
      if (!rows.length) return '📚 No upcoming deadlines. Send me a screenshot of your portal with the caption _deadlines_.';
      let last = '';
      const out = ['📚 *Upcoming deadlines*'];
      for (const d of rows) {
        const day = formatWhen(d.due_at, Date.now(), d.tz).replace(/ \d.*$/, '');
        if (day !== last) out.push(`\n*${day}* (${new Intl.DateTimeFormat('en-GB', { timeZone: d.tz, day: 'numeric', month: 'short' }).format(d.due_at)})`);
        last = day;
        out.push(`#${d.id} ${line(d).slice(2)}`);
      }
      out.push('\nDone with one? /deadlines done <id>');
      return out.join('\n');
    },
    markDone(chatId, id) {
      return db.prepare('UPDATE deadlines SET done_at = ? WHERE chat_id = ? AND id = ? AND done_at IS NULL').run(Date.now(), chatId, id).changes;
    },
  };
}
