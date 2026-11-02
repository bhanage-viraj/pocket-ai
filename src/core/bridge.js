// Phone side of the Mac bridge (see bridge/server.js): forwards /claude and /code prompts to
// Claude Code on the Mac and posts the answer back into the chat.
//
// Jobs live in SQLite. A poller (every 10 s) submits jobs that are still waiting for the Mac
// (asleep/offline -> they stay queued) and checks running ones until they finish. Nothing on the
// phone needs to be reachable: the phone only makes outgoing requests.
import { log } from '../util/log.js';

const TERMINAL = new Set(['done', 'error', 'lost']);

export function createBridge({ db, config, io }) {
  db.exec(`CREATE TABLE IF NOT EXISTS claude_jobs (
    id INTEGER PRIMARY KEY,
    remote_id TEXT,
    chat_id TEXT NOT NULL,
    sender TEXT,
    sender_name TEXT,
    mode TEXT NOT NULL,
    project TEXT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,          -- waiting (not yet sent) | sent | done | error | lost
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);

  const enabled = !!(config.bridgeUrl && config.bridgeToken);
  const q = {
    insert: db.prepare(
      'INSERT INTO claude_jobs (chat_id, sender, sender_name, mode, project, prompt, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ),
    pending: db.prepare("SELECT * FROM claude_jobs WHERE status IN ('waiting','sent') ORDER BY id"),
    setSent: db.prepare("UPDATE claude_jobs SET remote_id = ?, status = 'sent', updated_at = ? WHERE id = ?"),
    setStatus: db.prepare('UPDATE claude_jobs SET status = ?, updated_at = ? WHERE id = ?'),
    recentBy: db.prepare('SELECT COUNT(*) AS n FROM claude_jobs WHERE sender = ? AND created_at > ?'),
  };

  async function call(method, path, body) {
    const res = await fetch(`${config.bridgeUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.bridgeToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
    return json;
  }

  async function submit(job) {
    const r = await call('POST', '/jobs', { mode: job.mode, prompt: job.prompt, project: job.project, from: job.sender_name });
    q.setSent.run(r.id, Date.now(), job.id);
    return r;
  }

  function format(job, r) {
    const who = job.sender_name ? ` for ${job.sender_name}` : '';
    if (r.status === 'error') return `⚠️ *Claude*${who}: ${r.result || 'failed'}`;
    if (job.mode === 'code') {
      const branch = r.branch ? `\n\n🌿 Branch \`${r.branch}\` (${r.stat}). Not pushed. Review on the Mac:\ngit log -p main..${r.branch}` : '\n\n(no file changes)';
      return `🛠️ *Claude Code*${who}:\n${r.result}${branch}`;
    }
    return `🤖 *Claude*${who}:\n${r.result}`;
  }

  async function tick() {
    for (const job of q.pending.all()) {
      try {
        if (job.status === 'waiting') {
          await submit(job);
          await io.sendText(job.chat_id, `📨 Mac is back. Sent your ${job.mode === 'code' ? '/code' : '/claude'} request #${job.id} to Claude.`);
          continue;
        }
        const r = await call('GET', `/jobs/${job.remote_id}`);
        if (!TERMINAL.has(r.status)) continue;
        q.setStatus.run(r.status, Date.now(), job.id);
        await io.sendText(job.chat_id, format(job, r));
      } catch (err) {
        if (err.status === 404 && job.status === 'sent') {
          q.setStatus.run('lost', Date.now(), job.id);
          await io.sendText(job.chat_id, `⚠️ Claude request #${job.id} was lost on the Mac. Please send it again.`).catch(() => {});
        } else {
          log.debug(`bridge: job ${job.id} not reachable yet (${err.message})`);
        }
      }
    }
  }

  let timer = null;
  return {
    enabled,
    /** Create a job and try to send it right away. Returns a user-facing acknowledgement. */
    async enqueue({ chatId, sender, mode, prompt, project = null }) {
      const now = Date.now();
      const { lastInsertRowid: id } = q.insert.run(chatId, sender.number, sender.name, mode, project, prompt, 'waiting', now, now);
      try {
        const r = await submit({ id, mode, prompt, project, sender_name: sender.name });
        const wait = r.position > 0 ? ` (${r.position} ahead of you)` : '';
        return mode === 'code'
          ? `🛠️ Sent to Claude Code on the Mac${wait}. I'll post the result here. (#${id})`
          : `🧠 Asking Claude${wait}… (#${id})`;
      } catch (err) {
        log.warn(`bridge unreachable: ${err.message}`);
        return `💤 The Mac is offline. Queued #${id}; I'll send it to Claude as soon as the Mac is back.`;
      }
    },
    /** Non-owners: requests in the last hour. */
    usedLastHour(number) {
      return q.recentBy.get(number ?? '', Date.now() - 3_600_000).n;
    },
    async health() {
      return call('GET', '/health');
    },
    start() {
      if (!enabled || timer) return;
      timer = setInterval(() => tick().catch((e) => log.warn('bridge tick failed:', e.message)), 10_000);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
