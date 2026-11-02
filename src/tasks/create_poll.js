// Create a real WhatsApp poll: "@Pocket make a poll: goa dates, 14-16 dec or 21-23 dec",
// "poll banao kahan khana hai: dominos, kfc, subway", "@Pocket poll for movie night options".
// If the user lists options we use theirs; if not, the model suggests a few.
// Also /poll Question? | A | B | C   (plain code, no model).

const KEYWORDS = /\b(poll|polls|vote|voting|survey)\b/i;

/** Clean, de-duplicate and cap poll options (WhatsApp: 2-12 options). */
export function cleanOptions(options) {
  const seen = new Set();
  const out = [];
  for (const o of options || []) {
    const v = String(o ?? '').replace(/^[\s•*\-\d.)]+/, '').trim().slice(0, 100);
    const key = v.toLowerCase();
    if (v && !seen.has(key)) { seen.add(key); out.push(v); }
  }
  return out.slice(0, 12);
}

/** "/poll Where to eat? | Dominos | KFC" or "/poll Where to eat? Dominos, KFC, Subway" or "/poll multi …" */
export function parsePollCommand(argText) {
  let s = String(argText || '').trim();
  const multi = /^(multi|multiple|many)\b\s*/i.test(s);
  if (multi) s = s.replace(/^(multi|multiple|many)\b\s*/i, '');
  let parts = s.split(/\s*[|\n]\s*/).filter(Boolean);
  if (parts.length < 2 && s.includes('?')) {
    const [q, rest] = [s.slice(0, s.indexOf('?') + 1), s.slice(s.indexOf('?') + 1)];
    parts = [q, ...rest.split(/\s*(?:,|\bor\b|\/)\s*/i)];
  }
  const [question, ...options] = parts;
  return { question: (question || '').trim().slice(0, 255), options: cleanOptions(options), multi };
}

async function sendPoll(ctx, { question, options, multi }) {
  if (!question) return '📊 What should the poll ask? e.g. _/poll Where to eat? | Dominos | KFC | Subway_';
  if (options.length < 2) return `📊 I need at least 2 options for "${question}". e.g. _/poll ${question} | A | B_`;
  await ctx.io.sendPoll(ctx.chatId, { name: question, values: options, selectableCount: multi ? options.length : 1 });
  return null; // the poll itself is the reply
}

export default {
  name: 'create_poll',
  description:
    'User asks to create / make a poll or vote for the group ("make a poll", "poll banao", "let\'s vote on…"). ' +
    'Not for questions about polls or elections.',
  fields: {
    question: { type: 'string', description: 'the poll question, short, ending with "?"' },
    options: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 6,
      description: 'the choices: exactly the ones the user listed; if they listed none, suggest 2-5 sensible ones',
    },
    multi: { type: 'boolean', description: 'true only if they say people can pick more than one' },
  },
  examples: [
    {
      text: 'make a poll: which day for the trip, saturday or sunday',
      fields: { question: 'Which day for the trip?', options: ['Saturday', 'Sunday'], multi: false },
    },
    {
      text: 'poll banao kahan khana hai: dominos, kfc, subway',
      fields: { question: 'Kahan khana hai?', options: ['Dominos', 'KFC', 'Subway'], multi: false },
    },
    {
      text: 'create a poll for movie night genre, people can pick multiple',
      fields: { question: 'Movie night genre?', options: ['Comedy', 'Action', 'Horror', 'Thriller'], multi: true },
    },
  ],

  prefilter: (text) => KEYWORDS.test(text),
  postprocess: (fields) => ({ ...fields, options: cleanOptions(fields.options), multi: !!fields.multi }),

  async handle(ctx, fields) {
    return sendPoll(ctx, { question: String(fields.question || '').trim().slice(0, 255), options: cleanOptions(fields.options), multi: !!fields.multi });
  },

  commands: [
    {
      name: 'poll',
      description: 'Make a poll: /poll Question? | A | B | C  (/poll multi … for multiple answers)',
      groupDirect: true,
      async run(ctx) {
        const msg = await sendPoll(ctx, parsePollCommand(ctx.argText));
        if (msg) await ctx.reply(msg);
      },
    },
  ],
};
