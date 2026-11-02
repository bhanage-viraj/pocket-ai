import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { decide, createRouter } from '../src/core/router.js';
import { createQueue } from '../src/core/queue.js';
import { createRateLimiter } from '../src/core/ratelimit.js';
import { createMemory } from '../src/core/memory.js';
import { createMetrics } from '../src/core/metrics.js';
import { openDb } from '../src/db/index.js';
import { loadTasks } from '../src/tasks/index.js';
import { loadCommands } from '../src/commands/index.js';
import { parsePollCommand, cleanOptions } from '../src/tasks/create_poll.js';

const tasks = await loadTasks();
const commands = await loadCommands(tasks);

test('/poll parsing: pipes, "?" + commas/or, multi', () => {
  assert.deepEqual(parsePollCommand('Where to eat? | Dominos | KFC | Subway'), { question: 'Where to eat?', options: ['Dominos', 'KFC', 'Subway'], multi: false });
  assert.deepEqual(parsePollCommand('Trip day? saturday or sunday'), { question: 'Trip day?', options: ['saturday', 'sunday'], multi: false });
  assert.deepEqual(parsePollCommand('multi Movie genre? comedy, action, horror').multi, true);
  assert.deepEqual(parsePollCommand('just a question').options, []);
  assert.deepEqual(cleanOptions(['1. Goa', '• goa', ' Manali ', '', null]), ['Goa', 'Manali']);
});

function harness(intent) {
  const db = openDb(':memory:');
  for (const t of tasks) t.migrate?.(db);
  const polls = [];
  const replies = [];
  const router = createRouter({
    config, db, tasks, commands, memory: createMemory(db), metrics: createMetrics(db),
    llm: { health: async () => true, model: async () => 'fake' },
    detector: { detect: async () => ({ via: 'model', ms: 1, ...intent }) },
    chat: { reply: async () => 'chat' },
    queue: createQueue(), limiter: createRateLimiter({ perMinute: 10 }),
    io: { reply: async (_m, t) => replies.push(t), setTyping: async () => {}, sendPoll: async (c, p) => polls.push([c, p]) },
  });
  return { router, polls, replies };
}
const group = (text, over = {}) => ({
  id: '1', chatId: 'g@g.us', isGroup: true, text, timestamp: 0, mentionsBot: false, repliesToBot: false,
  sender: { jid: 'r@lid', number: '919822222222', name: 'Rahul' }, ...over,
});

test('natural language: "@Pocket make a poll …" sends a real poll and no extra text', async () => {
  const h = harness({ intent: 'create_poll', fields: { question: 'Which day?', options: ['Sat', 'Sun', 'sat'], multi: false } });
  await h.router.handle(group('make a poll which day saturday or sunday', { mentionsBot: true }));
  assert.deepEqual(h.polls, [['g@g.us', { name: 'Which day?', values: ['Sat', 'Sun'], selectableCount: 1 }]]);
  assert.deepEqual(h.replies, []);
});

test('/poll works in groups without tagging; bad input gets help', async () => {
  assert.equal(decide(group('/poll Lunch? | Pizza | Biryani'), { config, commands }).name, 'poll');
  const h = harness({ intent: 'chat', fields: {} });
  await h.router.handle(group('/poll Lunch? | Pizza | Biryani'));
  assert.deepEqual(h.polls[0][1], { name: 'Lunch?', values: ['Pizza', 'Biryani'], selectableCount: 1 });
  await h.router.handle(group('/poll Lunch?'));
  assert.match(h.replies[0], /at least 2 options/);
});
