// Set a reminder: "remind me tomorrow 9am to call mom", "kal subah 9 baje yaad dilana gym jaana hai".
// The model only extracts WHAT and the WHEN phrase; plain code (src/util/when.js) turns the phrase
// into a time in the configured timezone. src/core/reminders.js sends it when due.
import { parseWhen, formatWhen } from '../util/when.js';

const KEYWORDS = /\b(remind|reminder|yaad dila|yaad dilana|yaad dilaana|alarm|notify me|ping me|alert me)/i;

export default {
  name: 'set_reminder',
  description:
    'User wants to be reminded / pinged at a specific time ("remind me at 5", "kal 9 baje yaad dilana", "in 10 min ping me"). Has a time.',
  fields: {
    what: {
      type: 'string',
      description: 'what to remind about, short, in the user\'s words, without the time',
      grounded: 0.6,
    },
    when: {
      type: ['string', 'null'],
      description: 'the time phrase exactly as written ("tomorrow 9am", "kal shaam 6 baje", "in 10 minutes"), else null',
      grounded: true,
    },
  },
  examples: [
    { text: 'remind me tomorrow at 9am to call mom', fields: { what: 'call mom', when: 'tomorrow at 9am' } },
    { text: 'kal subah 9 baje yaad dilana gym jaana hai', fields: { what: 'gym jaana hai', when: 'kal subah 9 baje' } },
    { text: 'in 10 minutes remind me to take the pizza out', fields: { what: 'take the pizza out', when: 'in 10 minutes' } },
    { text: 'friday 5 pm ko reminder: submit assignment', fields: { what: 'submit assignment', when: 'friday 5 pm' } },
  ],

  prefilter: (text) => KEYWORDS.test(text),

  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender TEXT,
      sender_jid TEXT,
      sender_name TEXT,
      what TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent_at, due_at);`);
  },

  async handle(ctx, fields) {
    const tz = ctx.config.timezone;
    const when = parseWhen(fields.when, { tz }) || parseWhen(ctx.text, { tz });
    const what = cleanWhat(fields.what || ctx.text, fields.when);
    if (!when) {
      return '⏰ When should I remind you? e.g. _"remind me tomorrow 9am to …"_ or _"10 min baad yaad dilana …"_';
    }
    const { lastInsertRowid: id } = ctx.db
      .prepare('INSERT INTO reminders (chat_id, sender, sender_jid, sender_name, what, due_at, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(ctx.chatId, ctx.sender.number, ctx.sender.jid ?? null, ctx.sender.name ?? null, what, when.at, Date.now());
    return `⏰ Done! I'll remind you *${when.label}*: ${what} (#${id})`;
  },

  commands: [
    {
      name: 'reminders',
      description: 'Your upcoming reminders here (/reminders cancel <id>)',
      async run(ctx) {
        const tz = ctx.config.timezone;
        const [sub, id] = ctx.args;
        if (/^(cancel|delete|del|rm)$/i.test(sub || '')) {
          const row = ctx.db.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ? AND sent_at IS NULL').get(Number(id), ctx.chatId);
          if (!row) return ctx.reply(`No pending reminder #${id} here.`);
          if (row.sender !== ctx.sender.number && !ctx.sender.isOwner) return ctx.reply('⛔ Only the person who set it can cancel it.');
          ctx.db.prepare('DELETE FROM reminders WHERE id = ?').run(row.id);
          return ctx.reply(`🗑️ Cancelled reminder #${row.id}: ${row.what}`);
        }
        const rows = ctx.db
          .prepare('SELECT * FROM reminders WHERE chat_id = ? AND sent_at IS NULL ORDER BY due_at LIMIT 15')
          .all(ctx.chatId);
        if (!rows.length) return ctx.reply('No upcoming reminders. Try _"remind me in 10 min to …"_');
        return ctx.reply(
          `⏰ *Upcoming*\n${rows.map((r) => `#${r.id} ${formatWhen(r.due_at, Date.now(), tz)}: ${r.what}${ctx.isGroup && r.sender_name ? ` (${r.sender_name})` : ''}`).join('\n')}\n\nCancel: /reminders cancel <id>`,
        );
      },
    },
  ],
};

/** Strip "remind me", the time phrase and filler so the reminder reads cleanly. */
export function cleanWhat(what, when) {
  let s = String(what || '');
  if (when) s = s.replace(when, ' ');
  s = s
    .replace(/\b(please|pls|plz)\b/gi, ' ')
    .replace(/\b(remind me|reminder|set a reminder|ping me|notify me|alert me|yaad dila(na|ana|o|do)?|ko)\b\s*(to|that|about|:)?/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,-]+|[\s:,-]+$/g, '')
    .trim();
  return s || String(what || '').trim() || 'reminder';
}
