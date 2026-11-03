// Per-chat rolling history in SQLite. Stored as user/assistant pairs so roles always alternate
// (Gemma's chat template expects strict alternation).
// ttlMs: exchanges older than this are left out of the prompt, so a chat that went quiet for a few
// hours starts fresh instead of the model riffing on an old topic (they stay on disk until pruned).
export function createMemory(db, { turns = 6, maxChars = Infinity, msgChars = 500, ttlMs = 0 } = {}) {
  const insert = db.prepare('INSERT INTO messages (chat_id, role, sender, content, ts) VALUES (?,?,?,?,?)');
  const recent = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? AND ts > ? ORDER BY id DESC LIMIT ?');
  const clear = db.prepare('DELETE FROM messages WHERE chat_id = ?');
  const lastReply = db.prepare("SELECT MAX(ts) AS ts FROM messages WHERE chat_id = ? AND role = 'assistant'");
  const prune = db.prepare(
    'DELETE FROM messages WHERE chat_id = ? AND id NOT IN (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)',
  );

  return {
    /** Last `turns` exchanges, oldest first, as chat messages. */
    history(chatId) {
      const newest = recent.all(chatId, ttlMs > 0 ? Date.now() - ttlMs : 0, turns * 2);
      // newest first, until the character budget is used up (prompt reading is the slow part on a phone)
      const rows = [];
      let used = 0;
      for (const r of newest) {
        const content = r.content.length > msgChars ? r.content.slice(0, msgChars - 1) + '…' : r.content;
        if (rows.length && used + content.length > maxChars) break;
        used += content.length;
        rows.unshift({ role: r.role, content });
      }
      // drop a leading assistant message if the window cut a pair in half
      while (rows.length && rows[0].role !== 'user') rows.shift();
      return rows;
    },
    addExchange(chatId, sender, userText, assistantText) {
      const ts = Date.now();
      insert.run(chatId, 'user', sender ?? null, userText, ts);
      insert.run(chatId, 'assistant', null, assistantText, ts);
      prune.run(chatId, chatId, Math.max(turns * 2, 20)); // keep a little extra on disk
    },
    /** Time of the bot's last reply in this chat (0 if none). */
    lastReplyTs(chatId) {
      return lastReply.get(chatId)?.ts ?? 0;
    },
    clear(chatId) {
      clear.run(chatId);
    },
  };
}
