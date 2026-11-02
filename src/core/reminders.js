// Sends due reminders. Polls SQLite every 15 s, so reminders survive restarts; ones that came due
// while the phone was offline are sent as soon as it's back, marked late.
import { log } from '../util/log.js';

export function createReminderScheduler({ db, io, intervalMs = 15_000 }) {
  let timer = null;
  const hasTable = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders'").get();

  async function tick(now = Date.now()) {
    if (!hasTable()) return;
    const due = db.prepare('SELECT * FROM reminders WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 20').all(now);
    for (const r of due) {
      const late = now - r.due_at > 5 * 60_000 ? ' _(late, I was offline)_' : '';
      const isGroup = r.chat_id.endsWith('@g.us');
      const user = r.sender_jid?.split('@')[0];
      const who = isGroup && user ? `@${user} ` : '';
      try {
        await io.sendText(r.chat_id, `⏰ ${who}*Reminder:* ${r.what}${late}`, isGroup && r.sender_jid ? { mentions: [r.sender_jid] } : undefined);
        db.prepare('UPDATE reminders SET sent_at = ? WHERE id = ?').run(Date.now(), r.id);
      } catch (err) {
        log.warn(`reminder #${r.id} not sent yet: ${err.message}`); // offline: retried next tick
      }
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((e) => log.warn('reminder tick failed:', e.message)), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
