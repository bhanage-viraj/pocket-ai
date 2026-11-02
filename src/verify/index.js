// "@Pocket verify this" — free, on-device fact check.
//   1. claim -> search keywords (plain code)
//   2. evidence from open sources: Wikipedia (search + page summaries) and Google News RSS (headlines)
//   3. Gemma judges ONLY against that numbered evidence (grammar-constrained JSON)
//   4. code double-checks: no cited evidence -> "unverified", never a confident verdict from nothing
// A small model can be wrong, so the reply always shows the sources and says it's automatic.
import { SLOTS } from '../llm/client.js';

const UA = 'PocketAI/1.0 (on-device WhatsApp assistant; https://github.com/bhanage-viraj/pocket-ai)';
const STOP = new Set(('a an the is are was were be been of to in on for at by with and or not no this that these those it its ' +
  'as from about into than then so if do does did has have had will would can could should may might just only also very ' +
  'hai hain tha thi the ka ki ke ko se me mein ye yeh wo woh kya kyu kyun aur bhi to nahi na sach jhoot verify check true false ' +
  'please pls bhai yaar claim news fake real really i you he she they we my our your').split(' '));

export const VERDICTS = {
  true: '✅ *True*',
  false: '❌ *False*',
  misleading: '⚠️ *Misleading / partly true*',
  unverified: '❓ *Unverified*',
};

/** Claim -> a short keyword query (keeps numbers, names; drops filler). */
export function toQuery(claim) {
  const words = String(claim).toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) || [];
  return [...new Set(words.filter((w) => !STOP.has(w) && (w.length > 2 || /\d/.test(w))))].slice(0, 9).join(' ');
}

const decode = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Parse Google News RSS -> [{title, url, source, date}] */
export function parseNewsRss(xml, max = 5) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => decode(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(m[1])?.[1]);
    const source = get('source');
    let title = get('title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const date = get('pubDate') ? new Date(get('pubDate')).toISOString().slice(0, 10) : '';
    // Google News article links are ~600 encoded chars: link a search for the exact headline instead
    const url = `https://www.google.com/search?q=${encodeURIComponent(`"${title}"`)}`;
    items.push({ kind: 'news', title, url, source, date });
    if (items.length >= max) break;
  }
  return items;
}

export function createVerifier({ llm, fetchImpl = fetch, newsRegion = { hl: 'en-IN', gl: 'IN', ceid: 'IN:en' } } = {}) {
  async function get(url, type = 'json') {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: type === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
    return type === 'json' ? res.json() : res.text();
  }

  async function wikipedia(query) {
    const s = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=2&srsearch=${encodeURIComponent(query)}`);
    const hits = s?.query?.search || [];
    return Promise.all(hits.map(async (h) => {
      let text = decode(h.snippet);
      try {
        const sum = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, '_'))}`);
        if (sum?.extract) text = sum.extract;
      } catch { /* snippet is enough */ }
      return { kind: 'wiki', title: h.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`, source: 'Wikipedia', text: text.slice(0, 600) };
    }));
  }

  async function news(query) {
    const q = new URLSearchParams({ q: query, ...newsRegion });
    return parseNewsRss(await get(`https://news.google.com/rss/search?${q}`, 'text'), 5);
  }

  /** @returns {Promise<{verdict: string, reason: string, sources: object[], query: string}>} */
  async function verify(claim) {
    const query = toQuery(claim);
    if (!query) return { verdict: 'unverified', reason: 'There is no factual claim here to check.', sources: [], query };
    const settled = await Promise.allSettled([wikipedia(query), news(query)]);
    const evidence = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!evidence.length) {
      return { verdict: 'unverified', reason: 'I couldn\'t find any sources about this online.', sources: [], query };
    }

    const lines = evidence.map((e, i) =>
      e.kind === 'wiki' ? `[${i + 1}] Wikipedia "${e.title}": ${e.text}` : `[${i + 1}] News headline (${e.source || 'news'}, ${e.date}): ${e.title}`);
    const r = await llm.complete({
      slot: SLOTS.chat,
      temperature: 0,
      maxTokens: 160,
      jsonSchema: {
        type: 'object',
        properties: {
          verdict: { enum: ['true', 'false', 'misleading', 'unverified'] },
          reason: { type: 'string' },
          cited: { type: 'array', items: { type: 'integer' }, maxItems: 4 },
        },
        required: ['verdict', 'reason', 'cited'],
      },
      messages: [
        {
          role: 'system',
          content:
            'You are a careful fact-checker. Judge the CLAIM using ONLY the numbered EVIDENCE, not your own memory. ' +
            'true = evidence clearly confirms it. false = evidence clearly contradicts it. misleading = partly true or missing key context. ' +
            'unverified = evidence does not clearly address it (this is the right answer when unsure). ' +
            'reason: 1-2 short sentences saying what the evidence shows. cited: the evidence numbers you relied on.',
        },
        { role: 'user', content: `CLAIM: ${claim.slice(0, 500)}\n\nEVIDENCE:\n${lines.join('\n')}` },
      ],
    });
    let out;
    try {
      out = JSON.parse(r.text);
    } catch {
      out = { verdict: 'unverified', reason: 'I couldn\'t reach a clear conclusion.', cited: [] };
    }
    const cited = [...new Set((out.cited || []).filter((n) => n >= 1 && n <= evidence.length))];
    let verdict = VERDICTS[out.verdict] ? out.verdict : 'unverified';
    if (verdict !== 'unverified' && !cited.length) verdict = 'unverified'; // a verdict must point at evidence
    const shown = (cited.length ? cited.map((n) => evidence[n - 1]) : evidence).slice(0, 4);
    return { verdict, reason: String(out.reason || '').trim(), sources: shown, query };
  }

  return { verify };
}

/** WhatsApp message for a verification result. */
export function formatVerdict(claim, { verdict, reason, sources }) {
  const c = claim.length > 160 ? claim.slice(0, 159) + '…' : claim;
  const src = sources.map((s, i) => `${i + 1}. ${s.kind === 'wiki' ? 'Wikipedia' : s.source || 'News'}${s.date ? ` (${s.date})` : ''}: ${s.title}\n${s.url}`);
  return [
    '🔎 *Fact check*',
    `_"${c}"_`,
    '',
    `Verdict: ${VERDICTS[verdict]}`,
    reason,
    ...(src.length ? ['', '*Sources:*', ...src] : []),
    '',
    '_Checked automatically by a small on-device AI. Read the sources before forwarding._',
  ].join('\n');
}
