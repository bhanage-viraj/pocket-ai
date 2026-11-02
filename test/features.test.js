import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { loadTasks } from '../src/tasks/index.js';
import { stickerRequest } from '../src/core/router.js';
import { ruleSpec, buildFilter } from '../src/stickers/index.js';
import { parseWhen, formatWhen } from '../src/util/when.js';
import { cleanWhat } from '../src/tasks/set_reminder.js';
import { createReminderScheduler } from '../src/core/reminders.js';
import { createContext } from '../src/core/context.js';
import { createQueue } from '../src/core/queue.js';
import summary from '../src/commands/summary.js';

const img = { kind: 'image', download: async () => Buffer.from('') };
const base = { chatId: 'c', isGroup: false, sender: { number: '1' }, mentionsBot: false };

// ─── stickers ────────────────────────────────────────────────────────────────
test('sticker requests: DMs, group prefix, group reply that asks; not chatter', () => {
  assert.equal(stickerRequest({ ...base, text: 'make it a sticker', media: img }).prompt, 'make it a sticker');
  assert.equal(stickerRequest({ ...base, text: '/sticker "hi"', media: img }).prompt, '"hi"');
  assert.equal(stickerRequest({ ...base, text: 'cute pic', media: img }), null);
  assert.equal(stickerRequest({ ...base, text: 'sticker' }), null, 'needs media');
  const g = { ...base, isGroup: true };
  assert.equal(stickerRequest({ ...g, text: 'nice sticker', media: img }), null);
  assert.ok(stickerRequest({ ...g, text: 'sticker with text lol', media: img }));
  assert.ok(stickerRequest({ ...g, text: 'isko sticker bana do', quoted: { text: '', media: img } }), 'reply to a photo in a group');
  assert.ok(stickerRequest({ ...g, text: 'make a sticker of this', quoted: { text: '', media: img } }));
  assert.equal(stickerRequest({ ...g, text: 'nice sticker lol', quoted: { text: '', media: img } }), null);
  assert.ok(stickerRequest({ ...g, text: 'sticker pls', mentionsBot: true, quoted: { media: img } }));
});

test('sticker prompt -> spec (plain-code reading)', () => {
  assert.deepEqual(ruleSpec('sticker'), { text: null, position: 'bottom', color: 'white', shape: 'square' });
  assert.equal(ruleSpec('sticker with text "Monday mood"').text, 'Monday mood');
  assert.deepEqual(ruleSpec('round sticker, upar likho chai time in yellow'), { text: 'chai time', position: 'top', color: 'yellow', shape: 'circle' });
});

test('sticker filter graph renders with real ffmpeg (PNG, since WebP may be missing on the Mac)', (t) => {
  let ok = false;
  try { ok = /drawtext/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })); } catch {}
  const font = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/system/fonts/DroidSans-Bold.ttf'].find((f) => fs.existsSync(f));
  if (!ok || !font) return t.skip('ffmpeg with drawtext + a font not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const textFile = path.join(dir, 't.txt');
  fs.writeFileSync(textFile, 'chai time');
  for (const shape of ['square', 'circle', 'rounded']) {
    const out = path.join(dir, `${shape}.png`);
    const vf = buildFilter({ text: 'chai time', position: 'top', color: 'yellow', shape }, { animated: false, fontFile: font, textFile });
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', '-vf', vf, out]);
    const png = fs.readFileSync(out);
    assert.equal(png.readUInt32BE(16), 512, 'width 512');
    assert.equal(png.readUInt32BE(20), 512, 'height 512');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── reminders ───────────────────────────────────────────────────────────────
const TZ = 'Asia/Makassar';
const NOW = Date.UTC(2026, 10, 2, 6, 10); // Mon 2 Nov 14:10 local
const at = (s) => parseWhen(s, { now: NOW, tz: TZ })?.label ?? null;

test('time parsing: English + Hinglish', () => {
  const cases = {
    'in 10 minutes': 'today 2:20 PM', '10 min baad': 'today 2:20 PM', 'aadhe ghante mein': 'today 2:40 PM',
    'tomorrow 9am': 'tomorrow 9:00 AM', 'kal subah 9 baje': 'tomorrow 9:00 AM', 'kal shaam 6 baje': 'tomorrow 6:00 PM',
    'parso 7:30 pm': 'Wed 7:30 PM', 'friday 5:30 pm': 'Fri 5:30 PM', 'at 7': 'today 7:00 PM', '5 baje': 'today 5:00 PM',
    tonight: 'today 9:00 PM', 'next monday': '9 Nov 9:00 AM', 'dopahar 2 baje': 'tomorrow 2:00 PM', 'call mom': null, 'today 9am': null,
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(at(input), want, input);
  assert.equal(formatWhen(NOW + 3_600_000, NOW, TZ), 'today 3:10 PM');
});

test('reminder text is cleaned of the request words and the time', () => {
  assert.equal(cleanWhat('remind me tomorrow at 9am to call mom', 'tomorrow at 9am'), 'call mom');
  assert.equal(cleanWhat('kal subah 9 baje yaad dilana gym jaana hai', 'kal subah 9 baje'), 'gym jaana hai');
});

async function reminderDb() {
  const db = openDb(':memory:');
  for (const t of await loadTasks()) t.migrate?.(db);
  return db;
}

test('set_reminder saves it; the scheduler sends it once, with an @mention in groups', async () => {
  const db = await reminderDb();
  const task = (await loadTasks()).find((t) => t.name === 'set_reminder');
  const ctx = { db, config: { ...config, timezone: TZ }, chatId: 'g@g.us', text: 'remind me in 10 minutes to stretch', sender: { number: '91', jid: '123@lid', name: 'Viraj' } };
  const reply = await task.handle(ctx, { what: 'stretch', when: 'in 10 minutes' });
  assert.match(reply, /I'll remind you \*today .*\*: stretch \(#1\)/);

  const sent = [];
  const s = createReminderScheduler({ db, io: { sendText: async (...a) => sent.push(a) } });
  await s.tick(Date.now());
  assert.equal(sent.length, 0, 'not due yet');
  await s.tick(Date.now() + 11 * 60_000);
  await s.tick(Date.now() + 12 * 60_000);
  assert.equal(sent.length, 1, 'sent exactly once');
  assert.equal(sent[0][1], '⏰ @123 *Reminder:* stretch');
  assert.deepEqual(sent[0][2], { mentions: ['123@lid'] });

  const ask = await task.handle({ ...ctx, text: 'remind me to stretch' }, { what: 'stretch', when: null });
  assert.match(ask, /When should I remind you/);
});

// ─── group summary ───────────────────────────────────────────────────────────
test('/summary: what you missed since your last message, summarized by the model', async () => {
  const db = openDb(':memory:');
  const context = createContext(db);
  const say = (id, number, name, text) => context.observe({ id, chatId: 'g', isGroup: true, text, sender: { number, name } });
  say('1', 'me', 'Viraj', 'ok see you all later');
  for (let i = 0; i < 9; i++) say(`r${i}`, 'r', 'Rahul', `goa plan message ${i}`);
  say('s', 'me', 'Viraj', '/summary');

  let prompt = null;
  const replies = [];
  await summary.run({
    isGroup: true, chatId: 'g', sender: { number: 'me' }, msg: { id: 's' }, context, config: { summaryMaxLines: 40 },
    queue: createQueue(), reply: async (t) => replies.push(t),
    llm: { complete: async ({ messages }) => ((prompt = messages[1].content), { text: '• Rahul is planning Goa' }) },
  });
  assert.match(replies.at(-1), /^📝 \*What you missed\* \(9 messages\)\n• Rahul is planning Goa$/);
  assert.match(prompt, /\[Rahul\]: goa plan message 0/);
  assert.doesNotMatch(prompt, /see you all later|\/summary/);
});
