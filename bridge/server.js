// Mac bridge: receives prompts from the phone bot and runs them through Claude Code (`claude -p`).
//
//   mode "ask"  — anyone the bot allows (/claude). Claude answers with NO tools: it can't read or
//                 touch anything on this Mac. Runs in an empty temp dir.
//   mode "code" — owners only (/code). Claude works in a fresh git worktree on a new branch
//                 pocket/job-<id> (your checkout is never touched), may edit files and run tests,
//                 then the bridge commits on that branch. Nothing is ever pushed.
//
// One job at a time. The phone POSTs a job and polls GET /jobs/:id (no port needed on the phone).
// Run:  node bridge/server.js     (config: bridge/.env, see bridge/.env.example)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.BRIDGE_ENV_FILE || path.join(here, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

const TOKEN = env.BRIDGE_TOKEN || '';
const PORT = Number(env.BRIDGE_PORT || 7777);
const HOST = env.BRIDGE_HOST || '0.0.0.0';
const CLAUDE = env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = Number(env.BRIDGE_TIMEOUT_S || 900) * 1000;
const MAX_REPLY = 3500; // WhatsApp-friendly
/** "pocket-ai=/Users/me/whatsapp,blog=/Users/me/blog" -> Map(name -> path) */
const PROJECTS = new Map(
  String(env.BRIDGE_PROJECTS || '')
    .split(',')
    .map((s) => s.trim().split('='))
    .filter(([n, p]) => n && p)
    .map(([n, p]) => [n.trim().toLowerCase(), p.trim().replace(/^~(?=\/)/, os.homedir())]),
);
const DEFAULT_PROJECT = (env.BRIDGE_DEFAULT_PROJECT || [...PROJECTS.keys()][0] || '').toLowerCase();

if (TOKEN.length < 24) {
  console.error('BRIDGE_TOKEN missing or too short (min 24 chars). See bridge/.env.example');
  process.exit(1);
}

// ─── jobs (persisted so a bridge restart doesn't lose results) ───────────────
const jobsFile = env.BRIDGE_JOBS_FILE || path.join(here, 'jobs.json');
const jobs = new Map(fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, 'utf8')) : []);
let nextId = Math.max(0, ...[...jobs.keys()].map(Number)) + 1;
const save = () => {
  const keep = [...jobs.entries()].slice(-200);
  fs.writeFileSync(jobsFile, JSON.stringify(keep));
};
for (const j of jobs.values()) if (j.status === 'running' || j.status === 'queued') j.status = 'error', j.result = 'Bridge restarted before this job finished. Please resend.';
save();

const queue = [];
let busy = false;

const ASK_PROMPT =
  'You are answering a WhatsApp message forwarded by a bot. Answer directly and concisely. ' +
  'WhatsApp formatting only: *bold*, _italic_, simple lists. No markdown headings, no tables. Under 1200 characters unless asked for detail.';
const CODE_PROMPT =
  'You were asked via WhatsApp to work on this repository. You are in a fresh git worktree on a new branch. ' +
  'Make the change, run the tests if the project has them (npm test). Do NOT commit, push or switch branches; the bridge commits for you. ' +
  'Finish with a short summary for WhatsApp (2-6 lines, plain text): what you changed and whether tests pass.';

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

function run(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
  });
}

function parseClaude({ code, signal, out, err }) {
  if (signal) return { ok: false, text: `Claude was stopped (${signal}) after the ${TIMEOUT_MS / 60000} min limit.` };
  try {
    const j = JSON.parse(out.trim().split('\n').pop());
    return { ok: !j.is_error, text: String(j.result ?? '').trim() || '(no answer)', costUsd: j.total_cost_usd };
  } catch {
    return { ok: false, text: `Claude failed (exit ${code}): ${(err || out).trim().slice(0, 300)}` };
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function runAsk(job) {
  const dir = path.join(os.tmpdir(), 'pocket-bridge-ask');
  fs.mkdirSync(dir, { recursive: true });
  const args = ['-p', job.prompt, '--output-format', 'json', '--tools', '', '--safe-mode', '--strict-mcp-config',
    '--no-session-persistence', '--append-system-prompt', ASK_PROMPT];
  return parseClaude(await run(CLAUDE, args, { cwd: dir, timeoutMs: TIMEOUT_MS }));
}

async function runCode(job) {
  const repo = PROJECTS.get(job.project);
  if (!repo) return { ok: false, text: `Unknown project "${job.project}". Known: ${[...PROJECTS.keys()].join(', ') || 'none'}` };
  try { git(repo, 'fetch', '-q', 'origin'); } catch { /* offline: use local refs */ }
  let base;
  try { base = git(repo, 'rev-parse', '--verify', '-q', 'origin/main'); } catch { base = git(repo, 'rev-parse', 'HEAD'); }
  // (a commit id, not "HEAD": inside the worktree HEAD moves when we commit)
  const branch = `pocket/job-${job.id}`;
  const wt = path.join(path.dirname(repo), '.pocket-worktrees', `${job.project}-job-${job.id}`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, base);
  try {
    const nm = path.join(repo, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, 'node_modules'))) fs.symlinkSync(nm, path.join(wt, 'node_modules'));

    const args = ['-p', job.prompt, '--output-format', 'json', '--no-session-persistence',
      '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(ls:*)',
      '--append-system-prompt', CODE_PROMPT];
    const res = parseClaude(await run(CLAUDE, args, { cwd: wt, timeoutMs: TIMEOUT_MS }));

    try { fs.unlinkSync(path.join(wt, 'node_modules')); } catch { /* not a symlink we made */ }
    git(wt, 'add', '-A');
    let stat = '';
    if (git(wt, 'status', '--porcelain')) {
      const title = job.prompt.split('\n')[0].slice(0, 60);
      git(wt, '-c', 'user.name=Pocket bridge', '-c', 'user.email=pocket@localhost', 'commit', '-q', '-m', `pocket: ${title}`, '-m', `Requested via WhatsApp (job ${job.id}).`);
      stat = git(wt, 'diff', '--shortstat', `${base}..HEAD`);
    }
    return { ...res, branch: stat ? branch : null, stat };
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch (e) { log('worktree cleanup failed:', e.message); }
    try { if (!git(repo, 'log', '--oneline', `${base}..${branch}`)) git(repo, 'branch', '-q', '-D', branch); } catch { /* keep */ }
  }
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  job.status = 'running';
  job.startedAt = Date.now();
  save();
  log(`job ${job.id} [${job.mode}${job.project ? ' ' + job.project : ''}] from ${job.from || '?'}: ${job.prompt.slice(0, 80)}`);
  try {
    const r = job.mode === 'code' ? await runCode(job) : await runAsk(job);
    Object.assign(job, { status: r.ok ? 'done' : 'error', result: r.text.slice(0, MAX_REPLY), costUsd: r.costUsd, branch: r.branch ?? null, stat: r.stat ?? '' });
  } catch (e) {
    Object.assign(job, { status: 'error', result: `Bridge error: ${e.message}`.slice(0, 500) });
  }
  job.finishedAt = Date.now();
  log(`job ${job.id} ${job.status} in ${Math.round((job.finishedAt - job.startedAt) / 1000)}s`);
  save();
  busy = false;
  pump();
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
const authed = (req) => {
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 20_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });

const server = http.createServer(async (req, res) => {
  if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, busy, queued: queue.length, projects: [...PROJECTS.keys()] });
  }
  if (req.method === 'POST' && url.pathname === '/jobs') {
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const prompt = String(body.prompt || '').trim().slice(0, 8000);
    const mode = body.mode === 'code' ? 'code' : 'ask';
    if (!prompt) return send(res, 400, { error: 'empty prompt' });
    const project = mode === 'code' ? String(body.project || DEFAULT_PROJECT).toLowerCase() : null;
    const job = { id: String(nextId++), mode, project, prompt, from: String(body.from || '').slice(0, 60), status: 'queued', createdAt: Date.now() };
    jobs.set(job.id, job);
    queue.push(job);
    save();
    pump();
    return send(res, 202, { id: job.id, position: queue.length - (busy ? 0 : 1) });
  }
  const m = /^\/jobs\/(\d+)$/.exec(url.pathname);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'unknown job' });
    const { id, status, result, branch, stat, costUsd, mode, project } = job;
    return send(res, 200, { id, status, result, branch, stat, costUsd, mode, project });
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () =>
  log(`Pocket bridge on ${HOST}:${PORT} · projects: ${[...PROJECTS.keys()].join(', ') || 'none'} (default ${DEFAULT_PROJECT || '-'})`),
);
