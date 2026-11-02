import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUrls, normalizeKey, stripUrls, toWhatsApp } from '../src/util/text.js';
import { percentile } from '../src/util/stats.js';
import { isGrounded, groundFields } from '../src/intent/ground.js';
import { stripNotePrefix } from '../src/tasks/save_note.js';

test('extractUrls trims trailing punctuation', () => {
  assert.deepEqual(extractUrls('see https://a.com/x, and http://b.io/y.'), ['https://a.com/x', 'http://b.io/y']);
  assert.equal(stripUrls('read https://a.com now'), 'read now');
});

test('normalizeKey matches project spellings', () => {
  assert.equal(normalizeKey('Pocket AI'), normalizeKey('pocket-ai'));
});

test('toWhatsApp converts markdown', () => {
  assert.equal(toWhatsApp('## Title\n**bold** and __it__\n- one'), '*Title*\n*bold* and _it_\n• one');
  assert.equal(toWhatsApp('[docs](https://x.dev)'), 'docs (https://x.dev)');
});

test('percentile', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([], 50), 0);
});

test('grounding drops invented values, keeps real ones', () => {
  const task = { fields: { project: { grounded: true }, topic: {} } };
  const text = 'saw this blog https://pocketx.dev for my Pocket-AI project';
  assert.deepEqual(groundFields(task, { project: 'pocket ai', topic: 'x' }, text), { project: 'pocket ai', topic: 'x' });
  assert.deepEqual(groundFields(task, { project: 'weekend plans', topic: 'x' }, text), { project: null, topic: 'x' });
  // words only inside a URL do not count
  assert.equal(isGrounded('pocketx', text), false);
  // partial grounding for free text
  assert.equal(isGrounded('friday demo weekend ideas', 'yaad rakhna ki friday ko demo hai', 0.7), false);
  assert.equal(isGrounded('friday ko demo', 'yaad rakhna ki friday ko demo hai', 0.7), true);
});

test('stripNotePrefix', () => {
  assert.equal(stripNotePrefix('yaad rakhna ki friday ko demo hai'), 'friday ko demo hai');
  assert.equal(stripNotePrefix('Note: buy milk'), 'buy milk');
  assert.equal(stripNotePrefix('remember that x is 5'), 'x is 5');
  assert.equal(stripNotePrefix('note'), 'note');
});
