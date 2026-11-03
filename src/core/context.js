// Who the bot is talking to, and what was said around it.
//
//   observe(msg)  — called for EVERY incoming message (also ones the bot ignores):
//                   updates the `people` table and, in groups, the rolling `chat_log`.
//   build(...)    — a short context block for the chat model:
//                   1. group messages since the bot last spoke (so "@Pocket what do you think?" works)
//                   2. who is talking, and what they asked the bot to remember (save_note rows)
//
// Privacy rule for remembered facts: in a DM you see everything that person saved anywhere;
// in a group only what was saved in that same group. A DM note never leaks into a group.
const KEEP_LINES = 120; // per group, on disk (context uses the last few, /summary up to SUMMARY_MAX_LINES)

// Group chatter is only shown to the model when the message points at it. A small model given
// "hi" plus six lines about something else will happily comment on that something else.
const REFERS_TO_CHAT = new RegExp(
  [
    String.raw`\b(what|wat|wht) (do|d) (you|u) (think|say|reckon)`, String.raw`\bthoughts\b`, String.raw`\b(agree|disagree)\b`,
    String.raw`\bwho(?:'s| is)? (right|correct|wrong)\b`, String.raw`\b(above|earlier|discussion|convo|conversation|they said|he said|she said)\b`,
    String.raw`\b(summari[sz]e|summary|recap|tl;?dr|what did i miss|catch me up)\b`,
    String.raw`\b(this|that|these|those|it)\b.*\?`, String.raw`\b(explain|clarify)\b`, String.raw`\bsettle\b`,
    // Hinglish
    String.raw`\b(kya bolta|kya kehta|kya lagta|tu bata|tum batao|aap batao|sahi kaun|kaun sahi|upar|ye kya|yeh kya|isme|iska|uska|unka)\b`,
  ].join('|'),
  'i',
);
export const refersToChat = (text = '') => REFERS_TO_CHAT.test(text);

export function createContext(db, { groupLines = 12, groupMaxMs = 30 * 60_000, factsPerPerson = 5, lineChars = 140 } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      msg_id TEXT,
      sender TEXT,
      name TEXT,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_log_chat ON chat_log(chat_id, id);
    CREATE TABLE IF NOT EXISTS people (
      number TEXT PRIMARY KEY,
      name TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0
    );
  `);

  const upsertPerson = db.prepare(`
    INSERT INTO people (number, name, first_seen, last_seen, messages) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(number) DO UPDATE SET name = COALESCE(excluded.name, name), last_seen = excluded.last_seen,
      messages = messages + 1`);
  const insertLine = db.prepare('INSERT INTO chat_log (chat_id, msg_id, sender, name, text, ts) VALUES (?,?,?,?,?,?)');
  const pruneLines = db.prepare(
    'DELETE FROM chat_log WHERE chat_id = ? AND id NOT IN (SELECT id FROM chat_log WHERE chat_id = ? ORDER BY id DESC LIMIT ?)',
  );
  const linesSince = db.prepare(
    'SELECT sender, name, text FROM chat_log WHERE chat_id = ? AND ts > ? AND (msg_id IS NULL OR msg_id != ?) ORDER BY id DESC LIMIT ?',
  );
  const clearLines = db.prepare('DELETE FROM chat_log WHERE chat_id = ?');
  const getPerson = db.prepare('SELECT * FROM people WHERE number = ?');
  const lastOwnLine = db.prepare('SELECT MAX(id) AS id FROM chat_log WHERE chat_id = ? AND sender = ? AND (msg_id IS NULL OR msg_id != ?)');
  const linesAfter = db.prepare('SELECT name, text, ts FROM chat_log WHERE chat_id = ? AND id > ? AND (msg_id IS NULL OR msg_id != ?) ORDER BY id DESC LIMIT ?');

  const hasNotes = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'").get();
  function factsFor(number, { chatId, isGroup }) {
    if (!number || !hasNotes()) return [];
    const sql = `SELECT content FROM notes WHERE sender = ? ${isGroup ? 'AND chat_id = ?' : ''} ORDER BY id DESC LIMIT ?`;
    const args = isGroup ? [number, chatId, factsPerPerson] : [number, factsPerPerson];
    return db.prepare(sql).all(...args).map((r) => r.content).reverse();
  }

  const clip = (s) => (s.length > lineChars ? s.slice(0, lineChars - 1) + '…' : s);

  return {
    observe(msg) {
      const now = Date.now();
      const name = msg.sender?.name && msg.sender.name !== msg.sender.number ? msg.sender.name : null;
      if (msg.sender?.number) upsertPerson.run(msg.sender.number, name, now, now);
      if (msg.isGroup && msg.text) {
        insertLine.run(msg.chatId, msg.id ?? null, msg.sender?.number ?? null, msg.sender?.name ?? null, msg.text, now);
        pruneLines.run(msg.chatId, msg.chatId, KEEP_LINES);
      }
    },

    /**
     * Context block (string, '' if nothing useful). `since` = ts of the bot's last reply in this chat.
     * Group lines only come in when `text` refers to the conversation, and only recent ones.
     */
    build({ chatId, isGroup, sender, msgId, since = 0, text = '' }) {
      const parts = [];
      const speakers = new Map(); // number -> name

      if (isGroup && groupLines > 0 && refersToChat(text)) {
        const from = groupMaxMs > 0 ? Math.max(since, Date.now() - groupMaxMs) : since;
        const lines = linesSince.all(chatId, from, msgId ?? '', groupLines).reverse();
        if (lines.length) {
          parts.push('Recent messages in this group (not addressed to you):');
          for (const l of lines) {
            parts.push(`[${l.name || 'Someone'}]: ${clip(l.text)}`);
            if (l.sender) speakers.set(l.sender, l.name);
          }
        }
      } else if (!isGroup && sender?.name) {
        parts.push(`You are chatting with ${sender.name}.`);
      }

      if (sender?.number) speakers.set(sender.number, sender.name);
      for (const [number, name] of speakers) {
        const facts = factsFor(number, { chatId, isGroup });
        if (facts.length) parts.push(`${name || 'This person'} asked you to remember: ${facts.map(clip).join('; ')}`);
      }

      return parts.join('\n');
    },

    /**
     * Group messages for /summary: everything since `number` last spoke ("what did I miss"),
     * or the last `max` lines if that's too little. Excludes the /summary message itself.
     */
    transcript(chatId, { number, max = 40, min = 8, excludeId = '' } = {}) {
      const since = number ? lastOwnLine.get(chatId, number, excludeId)?.id ?? 0 : 0;
      let rows = linesAfter.all(chatId, since, excludeId, max);
      let missed = since > 0;
      if (rows.length < min) {
        rows = linesAfter.all(chatId, 0, excludeId, max);
        missed = false;
      }
      return { lines: rows.reverse().map((r) => ({ name: r.name || 'Someone', text: clip(r.text), ts: r.ts })), missed };
    },

    person(number) {
      return number ? getPerson.get(number) ?? null : null;
    },
    facts: factsFor,
    clear(chatId) {
      clearLines.run(chatId);
    },
  };
}
