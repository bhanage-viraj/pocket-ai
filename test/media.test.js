import './setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMedia } from '../src/media/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-media-test-'));
let seen = null;
const vision = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    seen = JSON.parse(b);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '  A cat  falls off a table, looking shocked. ' } }] }));
  });
});
await new Promise((r) => vision.listen(0, '127.0.0.1', r));
after(() => {
  vision.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const media = (over = {}) => createMedia({
  config: {
    dataDir, voiceMaxS: 120, whisperModel: 'm.bin', whisperLang: 'auto', mediaThreads: 2,
    ffmpegBin: path.resolve('test/fixtures/fake-ffmpeg.sh'), whisperBin: path.resolve('test/fixtures/fake-whisper.sh'),
    visionUrl: `http://127.0.0.1:${vision.address().port}`, ...over,
  },
});
const blob = (s) => ({ download: async () => Buffer.from(s) });

test('voice: transcript with whisper tags stripped', async () => {
  const r = await media().toText({ kind: 'voice', ...blob('kal ka plan kya hai') });
  assert.equal(r.text, 'kal ka plan kya hai');
  assert.equal(r.transcript, 'kal ka plan kya hai');
});

test('gif: one frame goes to the vision model, description becomes the message', async () => {
  const r = await media().toText({ kind: 'gif', ...blob('fake-frame-bytes') });
  assert.equal(r.text, '[sent a GIF showing: A cat falls off a table, looking shocked.]');
  const img = seen.messages[0].content.find((c) => c.type === 'image_url').image_url.url;
  assert.equal(Buffer.from(img.split(',')[1], 'base64').toString(), 'fake-frame-bytes');
});

test('vision down -> still answers with a plain label', async () => {
  const r = await media({ visionUrl: 'http://127.0.0.1:1' }).toText({ kind: 'sticker', ...blob('x') });
  assert.equal(r.text, '[sent a sticker]');
});
