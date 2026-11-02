import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { createRouter, decide } from '../src/core/router.js';
import { createQueue } from '../src/core/queue.js';
import { createRateLimiter } from '../src/core/ratelimit.js';
import { createMemory } from '../src/core/memory.js';
import { createContext } from '../src/core/context.js';
import { createMetrics } from '../src/core/metrics.js';
import { openDb } from '../src/db/index.js';
import { loadTasks } from '../src/tasks/index.js';
import { loadCommands } from '../src/commands/index.js';

const OWNER = '919811111111';
const FRIEND = '919822222222';
const STRANGER = '919833333333';

const msg = (over = {}) => ({
  id: '1', chatId: `${OWNER}@s.whatsapp.net`, isGroup: false, text: 'hi', timestamp: 0,
  sender: { jid: `${OWNER}@s.whatsapp.net`, number: OWNER, name: 'Owner' },
  mentionsBot: false, repliesToBot: false, ...over,
});
const group = (text, over = {}) =>
  msg({ chatId: 'g1@g.us', isGroup: true, text, sender: { jid: 'x@lid', number: FRIEND, name: 'Rahul' }, ...over });

const tasks = await loadTasks();
const commands = await loadCommands(tasks);
const d = (m) => decide(m, { config, commands });

test('DM policy: owner and allowlisted reply, strangers ignored', () => {
  assert.equal(d(msg()).action, 'ai');
  assert.equal(d(msg({ sender: { number: FRIEND, name: 'F' } })).action, 'ai');
  assert.deepEqual(d(msg({ sender: { number: STRANGER, name: 'S' } })), { action: 'ignore', reason: 'dm-not-allowed' });
});

test('groups: silent unless addressed', () => {
  assert.equal(d(group('anyone up for chai?')).action, 'ignore');
  assert.equal(d(group('what is rag', { mentionsBot: true })).text, 'what is rag');
  assert.equal(d(group('and why?', { repliesToBot: true })).action, 'ai');
  assert.equal(d(group('hey pocket: save https://x.dev')).text, 'save https://x.dev');
  assert.equal(d(group('/ai /stats')).name, 'stats');
  assert.equal(d(group('', { mentionsBot: true })).name, 'help');
});

test('commands: known, unknown, owner-only', () => {
  assert.equal(d(msg({ text: '/ping' })).name, 'ping');
  const unknown = d(msg({ text: '/nope arg' }));
  assert.equal(unknown.name, 'unknown');
  assert.equal(unknown.typed, 'nope');
  commands.set('secret', { name: 'secret', ownerOnly: true, run() {} });
  assert.equal(d(msg({ text: '/secret' })).action, 'command');
  assert.equal(d(msg({ text: '/secret', sender: { number: FRIEND, name: 'F' } })).action, 'deny');
  commands.delete('secret');
});

function harness({ intent = { intent: 'chat', fields: {} }, perMinute = 6 } = {}) {
  const db = openDb(':memory:');
  for (const t of tasks) t.migrate?.(db);
  const replies = [];
  const typing = [];
  const contexts = [];
  const memory = createMemory(db, { turns: 3 });
  const router = createRouter({
    config, db, tasks, commands, memory, context: createContext(db),
    llm: { health: async () => true, model: async () => 'fake' },
    detector: { detect: async () => ({ via: 'model', ms: 1, ...intent }) },
    chat: { reply: async ({ userContent, context }) => (contexts.push(context), `echo: ${userContent}`) },
    queue: createQueue({ max: 5 }),
    limiter: createRateLimiter({ perMinute }),
    metrics: createMetrics(db),
    io: { reply: async (_m, t) => replies.push(t), setTyping: async (c, on) => typing.push(on) },
  });
  return { router, replies, typing, db, memory, contexts };
}

test('chat path: reply, typing on/off, history with group names', async () => {
  const h = harness();
  await h.router.handle(group('hello bot', { mentionsBot: true }));
  assert.deepEqual(h.replies, ['echo: [Rahul]: hello bot']);
  assert.deepEqual(h.typing, [true, false]);
  assert.equal(h.memory.history('g1@g.us')[0].content, '[Rahul]: hello bot');
});

test('task path: save_resource stores the URL found by code', async () => {
  const h = harness({ intent: { intent: 'save_resource', fields: { project: 'pocket-ai', topic: 'RAG' } } });
  await h.router.handle(msg({ text: 'rag blog https://example.com/rag for pocket-ai' }));
  assert.match(h.replies[0], /Saved link/);
  const row = h.db.prepare('SELECT * FROM resources').get();
  assert.equal(row.url, 'https://example.com/rag');
  assert.equal(row.project, 'pocket-ai');
});

test('rate limit applies to non-owners only', async () => {
  const h = harness({ perMinute: 1 });
  await h.router.handle(msg({ sender: { jid: 'f', number: FRIEND, name: 'F' } }));
  await h.router.handle(msg({ sender: { jid: 'f', number: FRIEND, name: 'F' } }));
  assert.match(h.replies[1], /Too many/);
  await h.router.handle(msg());
  await h.router.handle(msg());
  assert.equal(h.replies.filter((r) => /Too many/.test(r)).length, 1);
});

test('group chatter the bot ignored is passed as context on the next mention', async () => {
  const h = harness();
  await h.router.handle(group('anyone up for chai?', { id: 'a' }));
  assert.equal(h.replies.length, 0);
  await h.router.handle(group('what do you think?', { id: 'b', mentionsBot: true }));
  assert.match(h.contexts[0], /\[Rahul\]: anyone up for chai\?/);
  assert.doesNotMatch(h.contexts[0], /what do you think/);
});

test('reply + @mention answers the quoted message; stale messages are context only', () => {
  const quoted = { text: 'kal ka match kaun jeetega?', id: 'q1' };
  const bare = d(group('', { mentionsBot: true, quoted }));
  assert.equal(bare.action, 'ai');
  assert.match(bare.text, /Reply to this message: "kal ka match kaun jeetega\?"/);
  const withText = d(group('in short', { mentionsBot: true, quoted }));
  assert.match(withText.text, /replying to: "kal ka match.*"\)\nin short/);
  assert.equal(d(group('/stats', { mentionsBot: true, quoted })).name, 'stats');
  assert.equal(d(group('', { mentionsBot: true })).name, 'help');
  assert.deepEqual(d(group('hello', { mentionsBot: true, stale: true })), { action: 'ignore', reason: 'stale' });
});

test('a stale group message still lands in the context', async () => {
  const h = harness();
  await h.router.handle(group('missed while offline', { id: 'old', stale: true }));
  assert.equal(h.replies.length, 0);
  await h.router.handle(group('what did I miss?', { id: 'new', mentionsBot: true }));
  assert.match(h.contexts[0], /missed while offline/);
});
