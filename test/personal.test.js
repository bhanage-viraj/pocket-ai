import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { parseDeadlines, createDeadlines } from '../src/core/deadlines.js';
import { createBrief, createSettings } from '../src/core/brief.js';
import { deadlinesRequest } from '../src/core/router.js';
import { bunk } from '../src/commands/bunk.js';

// Tesseract output from the real portal screenshots (incl. a wrapped course name)
const OCR = `~ Nov5
B Graded Assignment: Graded Quiz for Week 7 and
8
Software Development Practices « Due at 11:59 PM
IST
B Graded Assignment: Graded Quiz for Week 7 and
8
Modern Databases « Due at 11:59 PM IST
B Graded Assignment: Graded Quiz for Week 7 and
8
Network Programming and Client-Server Programmin
g « Due at 11:59 PM IST
^ Nov 15
© Graded Assignment: Staff Graded Assessment - 2
Software Development Practices • Due at 11:59 PM IST
Nov 20
Graded Assignment: Graded Quiz for Week 9 and 10
Modern Databases • Due at 11:59 PM IST`;

test('portal OCR -> deadlines (dates, IST, titles, courses, wrapped lines)', () => {
  const r = parseDeadlines(OCR, { defaultTz: 'UTC' });
  assert.equal(r.length, 5);
  assert.deepEqual(r[0], { title: 'Graded Assignment: Graded Quiz for Week 7 and 8', course: 'Software Development Practices', month: 11, day: 5, hour: 23, minute: 59, tz: 'Asia/Kolkata' });
  assert.equal(r[2].course, 'Network Programming and Client-Server Programming');
  assert.equal(r[3].title, 'Graded Assignment: Staff Graded Assessment - 2');
  assert.deepEqual([r[3].day, r[4].day, r[4].course], [15, 20, 'Modern Databases']);
  assert.deepEqual(parseDeadlines('hello world'), []);
});

const NOW = Date.UTC(2026, 10, 2, 6, 0); // 2 Nov 2026
const setup = () => {
  const db = openDb(':memory:');
  const sent = [];
  const io = { sendText: async (c, t) => sent.push([c, t]) };
  const deadlines = createDeadlines({ db, config: { dataDir: '/tmp', deadlineRemindAt: '00:00', tesseractBin: 'tesseract' }, io });
  return { db, sent, io, deadlines };
};

test('add: dedupes, skips past ones; one start-of-day reminder per due day, done items left out', async () => {
  const { sent, deadlines } = setup();
  const items = parseDeadlines(OCR);
  assert.equal(deadlines.add('me', items, NOW).added.length, 5);
  assert.equal(deadlines.add('me', items, NOW).skipped, 5, 'same screenshot twice -> no duplicates');
  assert.equal(deadlines.add('me', [{ ...items[0], month: 10, day: 1 }], NOW).past, 1);

  deadlines.markDone('me', 2); // Modern Databases quiz done
  await deadlines.tick(Date.UTC(2026, 10, 4, 18, 30)); // Nov 5 00:00 IST
  assert.equal(sent.length, 1, 'one message for the Nov 5 group');
  assert.match(sent[0][1], /^📚 \*Due TODAY\* \(by 11:59 PM GMT\+5:30\)/);
  assert.match(sent[0][1], /Software Development Practices/);
  assert.doesNotMatch(sent[0][1], /Modern Databases/);
  await deadlines.tick(Date.UTC(2026, 10, 4, 19, 0));
  assert.equal(sent.length, 1, 'not sent twice');
});

test('morning brief: once a day at BRIEF_TIME, lists today and this week', async () => {
  const { db, sent, io, deadlines } = setup();
  deadlines.add('me@lid', parseDeadlines(OCR), NOW);
  const settings = createSettings(db);
  settings.set('owner_chat', 'me@lid');
  const brief = createBrief({ db, io, deadlines, settings, config: { timezone: 'Asia/Kolkata', briefTime: '08:00', ownerNumbers: ['91'] } });
  const day = Date.UTC(2026, 10, 5, 2, 0); // Nov 5 07:30 IST
  await brief.tick(day);
  assert.equal(sent.length, 0, 'before 08:00');
  await brief.tick(day + 3_600_000); // 08:30
  await brief.tick(day + 2 * 3_600_000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'me@lid');
  assert.match(sent[0][1], /☀️ \*Good morning!\* Thu,? 5 Nov/);
  assert.match(sent[0][1], /📚 \*Due today\*\n• \*Software Development Practices\*/);
  settings.set('brief', 'off');
  await brief.tick(day + 86_400_000 + 3_600_000);
  assert.equal(sent.length, 1, 'off means off');
});

test('/bunk maths', () => {
  assert.deepEqual(bunk(42, 50, 75), { pct: 84, skip: 6, need: 0 }); // 42/56 = 75%
  assert.equal(bunk(30, 50, 75).need, 30); // (60/80 = 75%)
  assert.equal(bunk(3, 4, 75).skip, 0);
  assert.equal(bunk(5, 4), null);
});

test('screenshot routing: DM image (or reply to one) with "deadlines"; not groups, not other captions', () => {
  const img = { kind: 'image' };
  assert.ok(deadlinesRequest({ isGroup: false, text: 'deadlines', media: img }));
  assert.ok(deadlinesRequest({ isGroup: false, text: 'add these', quoted: { media: img } }));
  assert.equal(deadlinesRequest({ isGroup: true, text: 'deadlines', media: img }), null);
  assert.equal(deadlinesRequest({ isGroup: false, text: 'cute dog', media: img }), null);
});
