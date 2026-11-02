// Natural-language time -> timestamp, English + Hinglish, in a given IANA timezone. No dependencies.
//   "in 10 minutes", "10 min baad", "aadhe ghante mein", "tomorrow 9am", "kal subah 9 baje",
//   "parso shaam 6", "friday 5:30 pm", "at 7", "5 baje", "tonight", "next monday"
// Returns null when it can't find a time (the bot then asks "when?").

const NUM = { a: 1, an: 1, one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, chaar: 4, five: 5, paanch: 5, panch: 5, ten: 10, das: 10, fifteen: 15, pandrah: 15, twenty: 20, bees: 20, thirty: 30, tees: 30 };
const DAYS = [
  ['sun', 'sunday', 'ravivar', 'itvaar', 'itwar', 'raviwar'],
  ['mon', 'monday', 'somvar', 'somwar'],
  ['tue', 'tues', 'tuesday', 'mangalvar', 'mangalwar', 'mangal'],
  ['wed', 'wednesday', 'budhvar', 'budhwar', 'budh'],
  ['thu', 'thur', 'thurs', 'thursday', 'guruvar', 'guruwar', 'brihaspativar'],
  ['fri', 'friday', 'shukravar', 'shukrawar', 'shukra'],
  ['sat', 'saturday', 'shanivar', 'shaniwar', 'shani'],
];
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Wall-clock parts of `ms` in `tz`. */
function partsIn(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/** Wall-clock time in `tz` -> UTC ms (handles DST by re-checking the offset). */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(utc, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    utc += guess - asUtc;
  }
  return utc;
}

const unitOf = (u) => (/^(m|min|mins|minute|minutes|minat|minut)$/.test(u) ? 'm' : /^(h|hr|hrs|hour|hours|ghanta|ghante|ghanton)$/.test(u) ? 'h' : /^(d|day|days|din)$/.test(u) ? 'd' : null);

/**
 * @param {string} text
 * @param {{now?: number, tz?: string}} opts
 * @returns {{at: number, label: string}|null}
 */
export function parseWhen(text, { now = Date.now(), tz = 'UTC' } = {}) {
  const s = ` ${String(text || '').toLowerCase().replace(/[,!?]/g, ' ').replace(/\s+/g, ' ')} `;

  // 1. relative: "in 10 minutes", "10 min baad", "2 ghante mein", "half an hour", "aadhe ghante"
  if (/\b(half an hour|aadhe ghante|adhe ghante|aadha ghanta)\b/.test(s)) return finish(now + 30 * UNIT_MS.m, now, tz);
  const rel =
    /\b(?:in|after)\s+(\d+|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)\b/.exec(s) ||
    /\b(\d+|ek|do|teen|char|chaar|paanch|panch|das|pandrah|bees|tees)\s*(min|mins|minutes?|minat|minut|ghanta|ghante|ghanton|hours?|hrs?|din|days?)\s*(?:baad|bad|mein|me|mai|later)\b/.exec(s);
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? +rel[1] : NUM[rel[1]];
    const u = unitOf(rel[2]);
    if (n && u) return finish(now + n * UNIT_MS[u], now, tz);
  }

  // 2. day
  const today = partsIn(now, tz);
  let addDays = null;
  if (/\b(day after tomorrow|parso|parson)\b/.test(s)) addDays = 2;
  else if (/\b(tomorrow|tmrw|tmr|kal|kl)\b/.test(s)) addDays = 1;
  else if (/\b(today|aaj|tonight|aaj raat)\b/.test(s)) addDays = 0;
  let weekday = null;
  DAYS.forEach((names, i) => { if (names.some((n) => new RegExp(`\\b${n}\\b`).test(s))) weekday = i; });

  // 3. time of day
  let h = null;
  let mi = 0;
  const t =
    /\b(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/.exec(s) ||
    /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.|baje|bje|o'?clock)\b/.exec(s) ||
    /\b(?:at|@|by)\s+(\d{1,2})\b/.exec(s) ||
    /\b(?:subah|morning|shaam|sham|evening|raat|night|dopahar|afternoon)\s+(\d{1,2})\b/.exec(s);
  if (t) {
    h = +t[1];
    if (t[2] && /^\d{2}$/.test(t[2])) mi = +t[2];
    const ampm = (t[3] || (t[2] && !/^\d/.test(t[2]) ? t[2] : '') || '').replace(/\./g, '');
    if (ampm === 'pm' && h < 12) h += 12;
    else if (ampm === 'am' && h === 12) h = 0;
    else if (!/^(am|pm)$/.test(ampm)) {
      if (/\b(shaam|sham|evening|raat|night|tonight|dopahar|afternoon)\b/.test(s) && h < 12) h += h === 12 ? 0 : 12;
      else if (!/\b(subah|morning)\b/.test(s) && h >= 1 && h <= 7) h += 12; // "5 baje" -> 17:00
    }
    if (h > 23 || mi > 59) return null;
  } else if (/\b(morning|subah)\b/.test(s)) h = 9;
  else if (/\b(afternoon|dopahar)\b/.test(s)) h = 14;
  else if (/\b(evening|shaam|sham)\b/.test(s)) h = 18;
  else if (/\b(tonight|night|raat)\b/.test(s)) h = 21;

  if (h === null && addDays === null && weekday === null) return null;
  if (h === null) h = 9; // a day without a time -> 9 am

  let days = addDays ?? 0;
  if (weekday !== null && addDays === null) {
    days = (weekday - today.wd + 7) % 7;
    if (/\bnext\b/.test(s) && days === 0) days = 7;
  }
  const base = new Date(Date.UTC(today.y, today.mo - 1, today.d + days));
  let at = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi, tz);
  if (at <= now) {
    if (addDays === null && weekday === null) at = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate() + 1, h, mi, tz); // "at 7" already passed -> tomorrow
    else if (weekday !== null && addDays === null) at += 7 * UNIT_MS.d;
    else return null; // "today 9am" when it's 3pm
  }
  return finish(at, now, tz);
}

function finish(at, now, tz) {
  return { at, label: formatWhen(at, now, tz) };
}

/** "today 5:30 PM", "tomorrow 9:00 AM", "Fri 6:00 PM", "3 Nov 9:00 AM" */
export function formatWhen(at, now = Date.now(), tz = 'UTC') {
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
  const a = partsIn(at, tz);
  const n = partsIn(now, tz);
  const dayDiff = Math.round((Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(n.y, n.mo - 1, n.d)) / UNIT_MS.d);
  const day = dayDiff === 0 ? 'today'
    : dayDiff === 1 ? 'tomorrow'
    : dayDiff < 7 ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at)
    : new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(at);
  return `${day} ${time}`;
}
