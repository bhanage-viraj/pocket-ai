// SQLite via Node's built-in `node:sqlite` — no native npm module to compile on Android.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  sender TEXT,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- 'intent' | 'chat'
  model TEXT,
  prompt_n INTEGER, cache_n INTEGER, predicted_n INTEGER,
  prompt_ms REAL, predicted_ms REAL, wall_ms REAL
);
`;

/** Open (and migrate) a database. Pass ':memory:' in tests. */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(CORE_SCHEMA);
  return db;
}
