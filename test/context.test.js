import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createContext } from '../src/core/context.js';
import { loadTasks } from '../src/tasks/index.js';

const OWNER = '919811111111';
const FRIEND = '919822222222';
const G = 'g1@g.us';
const DM = `${OWNER}@s.whatsapp.net`;

async function setup(opts) {
  const db = openDb(':memory:');
  for (const t of await loadTasks()) t.migrate?.(db);
  return { db, ctx: createContext(db, opts) };
}
const gmsg = (id, number, name, text) => ({ id, chatId: G, isGroup: true, text, sender: { number, name } });
const note = (db, chatId, sender, content) =>
  db.prepare('INSERT INTO notes (chat_id, sender, project, content, created_at) VALUES (?,?,?,?,?)').run(chatId, sender, null, content, Date.now());

test('group context: lines since last reply, without the current message', async () => {
  const { ctx } = await setup();
  ctx.observe(gmsg('a', FRIEND, 'Rahul', 'anyone up for goa trip?'));
  ctx.observe(gmsg('b', OWNER, 'Viraj', 'only if its in december'));
  ctx.observe(gmsg('c', OWNER, 'Viraj', '@Pocket what do you think?'));
  const out = ctx.build({ chatId: G, isGroup: true, sender: { number: OWNER, name: 'Viraj' }, msgId: 'c', text: '@Pocket what do you think?' });
  assert.match(out, /\[Rahul\]: anyone up for goa trip\?/);
  assert.match(out, /\[Viraj\]: only if its in december/);
  assert.doesNotMatch(out, /what do you think/);
  // nothing new since "now"
  assert.equal(ctx.build({ chatId: G, isGroup: true, sender: { number: OWNER, name: 'Viraj' }, since: Date.now() + 1 }), '');
});

test('group context is capped, and 0 turns it off', async () => {
  const { ctx } = await setup({ groupLines: 3 });
  for (let i = 0; i < 10; i++) ctx.observe(gmsg(`m${i}`, FRIEND, 'Rahul', `line ${i}`));
  const out = ctx.build({ chatId: G, isGroup: true, sender: { number: FRIEND, name: 'Rahul' }, text: 'thoughts?' });
  assert.deepEqual(out.match(/line \d/g), ['line 7', 'line 8', 'line 9']);
  const off = (await setup({ groupLines: 0 })).ctx;
  off.observe(gmsg('x', FRIEND, 'Rahul', 'hello'));
  assert.equal(off.build({ chatId: G, isGroup: true, sender: { number: FRIEND }, text: 'thoughts?' }), '');
});

test('group context only when the message refers to the chat, and only recent lines', async () => {
  const { db, ctx } = await setup({ groupMaxMs: 30 * 60_000 });
  ctx.observe(gmsg('a', FRIEND, 'Rahul', 'is the lake water safe to swim in?'));
  const who = { chatId: G, isGroup: true, sender: { number: OWNER, name: 'Viraj' } };
  assert.equal(ctx.build({ ...who, text: '/ai hi' }), '', 'a greeting must not drag in the group chatter');
  assert.equal(ctx.build({ ...who, text: 'tell me a joke' }), '');
  assert.match(ctx.build({ ...who, text: 'what do you think?' }), /lake water/);
  assert.match(ctx.build({ ...who, text: 'bhai tu bata, sahi kaun hai' }), /lake water/);
  db.prepare('UPDATE chat_log SET ts = ?').run(Date.now() - 2 * 3600e3);
  assert.equal(ctx.build({ ...who, text: 'what do you think?' }), '', 'old chatter is dropped');
});

test('facts: DM sees all of the person\'s notes, a group only that group\'s', async () => {
  const { db, ctx } = await setup();
  note(db, DM, OWNER, 'my birthday is 5 may');
  note(db, G, OWNER, 'I am the trip organiser');
  note(db, G, FRIEND, 'Rahul is vegetarian');
  const dm = ctx.build({ chatId: DM, isGroup: false, sender: { number: OWNER, name: 'Viraj' } });
  assert.match(dm, /You are chatting with Viraj/);
  assert.match(dm, /birthday is 5 may/);
  assert.match(dm, /trip organiser/);

  ctx.observe(gmsg('a', FRIEND, 'Rahul', 'what should we eat'));
  const grp = ctx.build({ chatId: G, isGroup: true, sender: { number: OWNER, name: 'Viraj' }, text: 'what do you think?' });
  assert.match(grp, /trip organiser/);
  assert.match(grp, /Rahul asked you to remember: Rahul is vegetarian/);
  assert.doesNotMatch(grp, /birthday/, 'a DM note must not leak into a group');
});

test('people: name and message count tracked; clear() wipes the group log', async () => {
  const { ctx } = await setup();
  ctx.observe(gmsg('a', FRIEND, 'Rahul', 'hi'));
  ctx.observe(gmsg('b', FRIEND, null, 'again'));
  const p = ctx.person(FRIEND);
  assert.equal(p.name, 'Rahul');
  assert.equal(p.messages, 2);
  ctx.clear(G);
  assert.equal(ctx.build({ chatId: G, isGroup: true, sender: { number: FRIEND } }), '');
});
