// Per-chat rolling history in SQLite. Stored as user/assistant pairs so roles always alternate
// (Gemma's chat template expects strict alternation).
export function createMemory(db, { turns = 6 } = {}) {
  const insert = db.prepare('INSERT INTO messages (chat_id, role, sender, content, ts) VALUES (?,?,?,?,?)');
  const recent = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?');
  const clear = db.prepare('DELETE FROM messages WHERE chat_id = ?');
  const prune = db.prepare(
    'DELETE FROM messages WHERE chat_id = ? AND id NOT IN (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)',
  );

  return {
    /** Last `turns` exchanges, oldest first, as chat messages. */
    history(chatId) {
      const rows = recent.all(chatId, turns * 2).reverse();
      // drop a leading assistant message if the window cut a pair in half
      while (rows.length && rows[0].role !== 'user') rows.shift();
      return rows.map((r) => ({ role: r.role, content: r.content }));
    },
    addExchange(chatId, sender, userText, assistantText) {
      const ts = Date.now();
      insert.run(chatId, 'user', sender ?? null, userText, ts);
      insert.run(chatId, 'assistant', null, assistantText, ts);
      prune.run(chatId, chatId, Math.max(turns * 2, 20)); // keep a little extra on disk
    },
    clear(chatId) {
      clear.run(chatId);
    },
  };
}
