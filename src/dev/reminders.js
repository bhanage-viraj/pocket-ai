// Manage reminders from Termux (no WhatsApp message needed):
//   node src/dev/reminders.js groups              groups the bot has seen + who talks there
//   node src/dev/reminders.js list                pending reminders
//   node src/dev/reminders.js add <file.json>     add reminders: [{ "chat": "<group id or part of a member name>", "at": "2026-11-04T21:00:00+05:30", "text": "…" }]
// The running bot picks new rows up within 15 s.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openDb } from '../db/index.js';
import { loadTasks } from '../tasks/index.js';

const db = openDb(path.join(config.dataDir, 'pocket.db'));
for (const t of await loadTasks()) t.migrate?.(db);
const [cmd, arg] = process.argv.slice(2);

function groups() {
  const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has('chat_log')) return [];
  return db.prepare(`SELECT chat_id, COUNT(*) AS n, MAX(ts) AS last, GROUP_CONCAT(DISTINCT name) AS names
    FROM chat_log WHERE chat_id LIKE '%@g.us' GROUP BY chat_id ORDER BY last DESC`).all();
}

if (cmd === 'groups') {
  for (const g of groups()) console.log(`${g.chat_id}  (${g.n} msgs, last ${new Date(g.last).toLocaleString()})\n   ${g.names}`);
} else if (cmd === 'list') {
  for (const r of db.prepare('SELECT * FROM reminders WHERE sent_at IS NULL ORDER BY due_at').all()) {
    console.log(`#${r.id} ${new Date(r.due_at).toISOString()} ${r.chat_id}\n   ${r.what.replace(/\n/g, ' | ')}`);
  }
} else if (cmd === 'add' && arg) {
  const items = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const gs = groups();
  const ins = db.prepare('INSERT INTO reminders (chat_id, sender, sender_jid, sender_name, what, due_at, created_at) VALUES (?,?,?,?,?,?,?)');
  for (const it of items) {
    const chat = it.chat.includes('@') ? it.chat
      : gs.filter((g) => it.chat.split(',').every((n) => g.names?.toLowerCase().includes(n.trim().toLowerCase())));
    const chatId = typeof chat === 'string' ? chat : chat.length === 1 ? chat[0].chat_id : null;
    if (!chatId) throw new Error(`"${it.chat}" matches ${Array.isArray(chat) ? chat.length : 0} groups; use the group id from "groups"`);
    const due = Date.parse(it.at);
    if (!Number.isFinite(due)) throw new Error(`bad time ${it.at}`);
    const { lastInsertRowid } = ins.run(chatId, null, null, it.by ?? null, it.text, due, Date.now());
    console.log(`#${lastInsertRowid} ${new Date(due).toISOString()} -> ${chatId}`);
  }
} else {
  console.log('usage: node src/dev/reminders.js groups | list | add <file.json>');
}
