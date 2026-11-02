import './setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { createBridge } from '../src/core/bridge.js';

const TOKEN = 'test-token-0123456789abcdefghij';
const PORT = 17000 + Math.floor(Math.random() * 1000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-bridge-test-'));
const repo = path.join(tmp, 'demo');
let server;

before(async () => {
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  server = spawn(process.execPath, ['bridge/server.js'], {
    env: {
      ...process.env, BRIDGE_ENV_FILE: '/nonexistent', BRIDGE_TOKEN: TOKEN, BRIDGE_PORT: String(PORT), BRIDGE_HOST: '127.0.0.1',
      CLAUDE_BIN: path.resolve('test/fixtures/fake-claude.sh'), BRIDGE_PROJECTS: `demo=${repo}`,
      BRIDGE_JOBS_FILE: path.join(tmp, 'jobs.json'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.once('data', r)); // "Pocket bridge on …"
});
after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function phone(url = `http://127.0.0.1:${PORT}`, token = TOKEN) {
  const sent = [];
  const db = openDb(':memory:');
  const bridge = createBridge({ db, config: { bridgeUrl: url, bridgeToken: token }, io: { sendText: async (c, t) => sent.push([c, t]) } });
  return { bridge, sent, db };
}
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const SENDER = { number: '919811111111', name: 'Viraj' };

test('ask: forwarded with no tools, answer posted back to the chat', async () => {
  const { bridge, sent } = phone();
  const ack = await bridge.enqueue({ chatId: 'g@g.us', sender: SENDER, mode: 'ask', prompt: 'what is RAG?' });
  assert.match(ack, /Asking Claude/);
  await until(async () => (await bridge.tick(), sent.length > 0));
  assert.equal(sent[0][0], 'g@g.us');
  assert.match(sent[0][1], /Claude\* for Viraj:\nanswer to: what is RAG\? \(tools=none\)/);
});

test('code: runs in a worktree, commits on a new branch, leaves main untouched', async () => {
  const { bridge, sent } = phone();
  await bridge.enqueue({ chatId: 'dm', sender: SENDER, mode: 'code', prompt: 'add a file', project: 'demo' });
  await until(async () => (await bridge.tick(), sent.length > 0));
  const msg = sent[0][1];
  assert.match(msg, /Claude Code\* for Viraj/);
  const branch = /`(pocket\/job-\d+)`/.exec(msg)?.[1];
  assert.ok(branch, msg);
  const files = execFileSync('git', ['show', '--name-only', '--format=', branch], { cwd: repo, encoding: 'utf8' });
  assert.match(files, /CHANGED_BY_CLAUDE\.txt/);
  assert.equal(fs.existsSync(path.join(repo, 'CHANGED_BY_CLAUDE.txt')), false, 'main checkout untouched');
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').length, 1);
});

test('wrong token is rejected; Mac offline -> queued, sent later', async () => {
  const bad = phone(undefined, 'x'.repeat(30));
  await assert.rejects(bad.bridge.health(), /unauthorized/);

  const off = phone('http://127.0.0.1:1'); // nothing listens here
  const ack = await off.bridge.enqueue({ chatId: 'c', sender: SENDER, mode: 'ask', prompt: 'hi' });
  assert.match(ack, /Mac is offline\. Queued #1/);
  assert.equal(off.db.prepare('SELECT status FROM claude_jobs').get().status, 'waiting');
});
