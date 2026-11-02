// Save a short note / thought / todo, optionally for a project.
// Stems, not whole words: Hinglish inflects ("likhna", "likh lo", "bhoolna", "noted").
const KEYWORDS =
  /\b(note|jot|write (it )?down|remember|remind|don'?t forget|dont forget|todo|to-?do|idea|yaad|likh|bhool|bhul|dhyan|imp\b)/i;

export default {
  name: 'save_note',
  description:
    'User tells you a fact, idea or todo to note down / remember / jot ("note:", "remember that", "yaad rakhna", "todo"). No link, and no time to be reminded at (that is set_reminder).',
  fields: {
    note: {
      type: 'string',
      description: 'the information to remember, short, in the user\'s words',
      grounded: 0.7, // if the model paraphrases too much, handle() falls back to the message itself
    },
    project: {
      type: ['string', 'null'],
      description: 'project name ONLY if the user explicitly names one, else null. Never invent one.',
      grounded: true,
    },
  },
  examples: [
    {
      text: 'note: wifi password for office is tiger@123',
      fields: { note: 'wifi password for office is tiger@123', project: null },
    },
    {
      text: 'yaad rakhna ki kal 9 baje standup hai',
      fields: { note: 'kal 9 baje standup hai', project: null },
    },
    {
      text: 'remember that my bike insurance number is MH12-4471',
      fields: { note: 'bike insurance number is MH12-4471', project: null },
    },
    {
      text: 'todo for the chess app: fix the timer bug',
      fields: { note: 'fix the timer bug', project: 'chess app' },
    },
  ],

  prefilter: (text) => KEYWORDS.test(text),

  // Runs after grounding (also in the eval): fall back to the message itself if the note was dropped.
  postprocess: (fields, text) => ({ ...fields, note: fields.note || stripNotePrefix(text) }),

  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender TEXT,
      project TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`);
  },

  async handle(ctx, fields) {
    const content = String(fields.note || ctx.text).trim().slice(0, 1000);
    const { lastInsertRowid: id } = ctx.db
      .prepare('INSERT INTO notes (chat_id, sender, project, content, created_at) VALUES (?,?,?,?,?)')
      .run(ctx.chatId, ctx.sender.number, fields.project, content, Date.now());
    return `📝 Noted (#${id})${fields.project ? ` for *${fields.project}*` : ''}: ${content}`;
  },

  commands: [
    {
      name: 'notes',
      description: 'List / search notes: /notes [text]',
      async run(ctx) {
        const q = ctx.argText;
        const rows = ctx.db
          .prepare(
            `SELECT * FROM notes WHERE chat_id = ? ${q ? 'AND (content LIKE ? OR project LIKE ?)' : ''}
             ORDER BY id DESC LIMIT 15`,
          )
          .all(ctx.chatId, ...(q ? [`%${q}%`, `%${q}%`] : []));
        if (!rows.length) return ctx.reply('No notes yet.');
        return ctx.reply(
          `📝 *Notes*\n\n${rows.map((r) => `*#${r.id}*${r.project ? ` [${r.project}]` : ''} ${r.content}`).join('\n')}`,
        );
      },
    },
  ],
};

/** Plain-code fallback: "yaad rakhna ki X" / "note: X" / "remember that X" -> "X". */
export function stripNotePrefix(text) {
  return String(text)
    .replace(
      /^\s*(please\s+)?(note( this| down| kar lo| karo)?|jot( this)?( down)?|write( it)? down|remember( that)?|don'?t forget( that| to)?|todo|to-?do|yaad rakh(na|o)?( ki)?|likh (le|lo)|mat bhool(na)?( ki)?)\s*[:,-]?\s*/i,
      '',
    )
    .trim() || String(text).trim();
}
