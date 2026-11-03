import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, QueueFullError } from '../src/core/queue.js';
import { createRateLimiter } from '../src/core/ratelimit.js';
import { createMemory } from '../src/core/memory.js';
import { openDb } from '../src/db/index.js';
import { checkGroupTrigger, matchTextTrigger } from '../src/core/triggers.js';

test('queue runs one job at a time, in order, and reports position', async () => {
  const q = createQueue({ max: 3 });
  const log = [];
  let running = 0;
  const job = (id) => async () => {
    running++;
    assert.equal(running, 1, 'only one job at a time');
    await new Promise((r) => setTimeout(r, 5));
    log.push(id);
    running--;
    return id;
  };
  const a = q.push(job('a'));
  const b = q.push(job('b'));
  const c = q.push(job('c'));
  assert.deepEqual([a.position, b.position, c.position], [0, 1, 2]);
  assert.throws(() => q.push(job('d')), QueueFullError);
  assert.deepEqual(await Promise.all([a.done, b.done, c.done]), ['a', 'b', 'c']);
  assert.deepEqual(log, ['a', 'b', 'c']);
  assert.equal(q.size, 0);
});

test('queue propagates errors without stopping', async () => {
  const q = createQueue();
  const bad = q.push(async () => { throw new Error('boom'); });
  const good = q.push(async () => 'ok');
  await assert.rejects(bad.done, /boom/);
  assert.equal(await good.done, 'ok');
});

test('rate limiter: sliding window per key', () => {
  let t = 0;
  const rl = createRateLimiter({ perMinute: 2, now: () => t });
  assert.ok(rl.take('a'));
  assert.ok(rl.take('a'));
  assert.ok(!rl.take('a'));
  assert.ok(rl.take('b'));
  t = 61_000;
  assert.ok(rl.take('a'));
});

test('memory keeps last N exchanges, alternating roles', () => {
  const db = openDb(':memory:');
  const mem = createMemory(db, { turns: 2 });
  for (let i = 1; i <= 4; i++) mem.addExchange('c1', 'n', `u${i}`, `a${i}`);
  mem.addExchange('c2', 'n', 'other', 'chat');
  const h = mem.history('c1');
  assert.deepEqual(h.map((m) => m.content), ['u3', 'a3', 'u4', 'a4']);
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  mem.clear('c1');
  assert.deepEqual(mem.history('c1'), []);
  assert.equal(mem.history('c2').length, 2);
});

test('memory forgets exchanges older than ttlMs', () => {
  const db = openDb(':memory:');
  const mem = createMemory(db, { turns: 4, ttlMs: 3 * 3600e3 });
  mem.addExchange('c1', 'n', 'water safety talk', 'be careful');
  db.prepare('UPDATE messages SET ts = ?').run(Date.now() - 4 * 3600e3);
  assert.deepEqual(mem.history('c1'), [], 'a chat quiet for hours starts fresh');
  mem.addExchange('c1', 'n', 'hi', 'hey!');
  assert.deepEqual(mem.history('c1').map((m) => m.content), ['hi', 'hey!']);
});

test('text triggers are whole-word and case-insensitive', () => {
  const triggers = ['/ai', 'hey pocket'];
  assert.deepEqual(matchTextTrigger('Hey Pocket, what is RAG?', triggers), { trigger: 'hey pocket', rest: 'what is RAG?' });
  assert.deepEqual(matchTextTrigger('/ai hello', triggers), { trigger: '/ai', rest: 'hello' });
  assert.equal(matchTextTrigger('/aiden is here', triggers), null);
  assert.equal(matchTextTrigger('hey pocketful of sunshine', triggers), null);
  assert.equal(matchTextTrigger('so hey pocket', triggers), null);
});

test('group trigger: mention, reply, prefix, silence', () => {
  const base = { triggers: ['/ai'], mentionsBot: false, repliesToBot: false };
  assert.equal(checkGroupTrigger({ ...base, text: 'hello all' }).triggered, false);
  assert.equal(checkGroupTrigger({ ...base, text: 'hi', mentionsBot: true }).reason, 'mention');
  assert.equal(checkGroupTrigger({ ...base, text: 'and?', repliesToBot: true }).reason, 'reply');
  assert.equal(checkGroupTrigger({ ...base, text: '/ai yo' }).text, 'yo');
});
