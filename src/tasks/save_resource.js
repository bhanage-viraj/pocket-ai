// Save a link/resource (blog, video, repo, paper, docs) with project + notes.
// URL extraction and notes are plain code; the model only picks the intent, project and topic.
import { extractUrls, normalizeKey, stripUrls } from '../util/text.js';

// Stems, not whole words, so Hinglish forms match ("rakh le", "sambhal ke", "padhna").
const KEYWORDS =
  /\b(save|saev|bookmark|store|keep|read later|watch later|resource|link|blog|article|post|video|repo|github|paper|docs?\b|documentation|tutorial|course|playlist|thread|podcast|useful|kaam|rakh|sambhal|baad me|later)/i;

export default {
  name: 'save_resource',
  description:
    'User shares or mentions a link/resource (blog, article, video, repo, paper, docs, tutorial) ' +
    'and wants it kept for later or for a project.',
  fields: {
    project: {
      type: ['string', 'null'],
      description: 'project name ONLY if the user explicitly names one ("for my X project", "X ke liye"), else null. Never invent one.',
      grounded: true,
    },
    topic: {
      type: ['string', 'null'],
      description: 'what the resource is about in 1-4 words (e.g. "RAG", "React hooks"), else null',
    },
  },
  examples: [
    {
      text: 'saw this blog on RAG https://example.com/rag-guide useful for my study-buddy project',
      fields: { project: 'study-buddy', topic: 'RAG' },
    },
    {
      text: 'ye video baad me dekhna hai, transformers samjhata hai https://youtu.be/xyz',
      fields: { project: null, topic: 'transformers' },
    },
    {
      text: 'read later https://example.com/css-grid-guide',
      fields: { project: null, topic: 'CSS grid' },
    },
    {
      text: 'budget app ke liye rakh le https://github.com/foo/charts nice charts lib',
      fields: { project: 'budget app', topic: 'charts library' },
    },
  ],

  prefilter: (text) => extractUrls(text).length > 0 || KEYWORDS.test(text),

  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender TEXT,
      url TEXT,
      project TEXT,
      topic TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL
    );`);
  },

  async handle(ctx, fields) {
    const urls = extractUrls(ctx.text);
    const project = matchKnownProject(ctx.db, fields.project);
    const notes = stripUrls(ctx.text).slice(0, 500);
    const insert = ctx.db.prepare(
      'INSERT INTO resources (chat_id, sender, url, project, topic, notes, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    const targets = urls.length ? urls : [null];
    let id;
    for (const url of targets) {
      id = insert.run(ctx.chatId, ctx.sender.number, url, project, fields.topic, notes, Date.now()).lastInsertRowid;
    }
    const what = urls.length > 1 ? `${urls.length} links` : urls.length ? 'link' : 'resource';
    return [
      `📌 Saved ${what} (#${id})`,
      fields.topic && `Topic: *${fields.topic}*`,
      project && `Project: *${project}*`,
      `_/res ${project ? project : ''} to see saved items_`.replace('  ', ' '),
    ]
      .filter(Boolean)
      .join('\n');
  },

  commands: [
    {
      name: 'res',
      description: 'List / search saved resources: /res [text]',
      async run(ctx) {
        const q = ctx.argText;
        const scopeAll = ctx.sender.isOwner && !ctx.isGroup;
        const where = [];
        const params = [];
        if (!scopeAll) {
          where.push('chat_id = ?');
          params.push(ctx.chatId);
        }
        if (q) {
          where.push('(url LIKE ? OR project LIKE ? OR topic LIKE ? OR notes LIKE ?)');
          params.push(...Array(4).fill(`%${q}%`));
        }
        const rows = ctx.db
          .prepare(
            `SELECT * FROM resources ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 10`,
          )
          .all(...params);
        if (!rows.length) return ctx.reply(q ? `Nothing saved matching "${q}".` : 'Nothing saved yet.');
        const lines = rows.map((r) => {
          const tag = [r.topic, r.project && `📁 ${r.project}`].filter(Boolean).join(' · ');
          return `*#${r.id}* ${tag || '(untitled)'}\n${r.url || r.notes}`;
        });
        return ctx.reply(`📚 *Saved resources*${q ? ` matching "${q}"` : ''}\n\n${lines.join('\n\n')}`);
      },
    },
  ],
};

/** Map the model's project name onto an existing one ("Pocket AI" -> "pocket-ai") so lists stay tidy. */
function matchKnownProject(db, project) {
  if (!project) return null;
  const key = normalizeKey(project);
  const known = db.prepare('SELECT DISTINCT project FROM resources WHERE project IS NOT NULL').all();
  return known.find((r) => normalizeKey(r.project) === key)?.project ?? project.trim();
}
