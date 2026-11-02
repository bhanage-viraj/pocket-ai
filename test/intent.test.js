import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTasks } from '../src/tasks/index.js';
import { buildIntentSchema } from '../src/intent/schema.js';
import { buildMessages, forModel } from '../src/intent/prompt.js';
import { createIntentDetector } from '../src/intent/detect.js';
import { normalizeKey } from '../src/util/text.js';
import { matchField } from '../eval/matchers.js';

const tasks = await loadTasks();

test('registry: chat last, all tasks valid', () => {
  assert.equal(tasks.at(-1).name, 'chat');
  assert.ok(tasks.some((t) => t.name === 'save_resource'));
});

test('schema: one branch per task, intent first, no custom keys leak', () => {
  const s = buildIntentSchema(tasks);
  assert.equal(s.anyOf.length, tasks.length);
  for (const branch of s.anyOf) {
    assert.equal(Object.keys(branch.properties)[0], 'intent');
    assert.ok(!JSON.stringify(branch).includes('grounded'));
    assert.ok(!JSON.stringify(branch).includes('description'));
  }
});

test('prompt prefix is identical for every message (prompt cache)', () => {
  const a = buildMessages(tasks, 'one').slice(0, -1);
  const b = buildMessages(tasks, 'two https://x.dev').slice(0, -1);
  assert.deepEqual(a, b);
  assert.equal(forModel('see https://www.youtube.com/watch?v=1'), 'see <link:youtube.com>');
});

test('detector: prefilter skips the model for plain chat', async () => {
  let calls = 0;
  const llm = { complete: async () => { calls++; return { text: '{"intent":"chat"}', timings: {} }; } };
  const det = createIntentDetector({ llm, tasks });
  assert.equal((await det.detect('how are you?')).via, 'prefilter');
  assert.equal(calls, 0);
});

test('detector: parses JSON, grounds fields, falls back to chat on garbage', async () => {
  let out = '{"intent":"save_resource","project":"weekend plans","topic":"RAG"}';
  const llm = { complete: async () => ({ text: out, timings: {} }) };
  const det = createIntentDetector({ llm, tasks });
  const r = await det.detect('save https://x.dev/rag');
  assert.equal(r.intent, 'save_resource');
  assert.equal(r.fields.project, null); // invented -> nulled
  assert.equal(r.fields.topic, 'RAG');
  out = 'not json';
  assert.equal((await det.detect('save https://x.dev')).via, 'fallback');
});

test('few-shot examples never appear in the eval datasets (no leakage)', () => {
  const examples = new Set(tasks.flatMap((t) => t.examples.map((e) => normalizeKey(e.text))));
  const dir = new URL('../eval/datasets/', import.meta.url);
  for (const file of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(new URL(file, dir), 'utf8').split('\n').filter(Boolean)) {
      assert.ok(!examples.has(normalizeKey(JSON.parse(line).text)), `${file}: ${line.slice(0, 60)}`);
    }
  }
});

test('eval matchers', () => {
  assert.ok(matchField('pocket-ai', 'Pocket AI'));
  assert.ok(matchField(null, null));
  assert.ok(!matchField(null, 'x'));
  assert.ok(matchField({ any: ['ml', 'ml project'] }, 'ML Project'));
  assert.ok(matchField({ contains: ['rag'] }, 'RAG pipelines'));
  assert.ok(!matchField({ contains: ['rag'] }, null));
});
