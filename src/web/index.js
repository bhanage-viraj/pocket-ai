// Live info for the chat model, from free, open APIs (no scraping):
//   weather   -> Open-Meteo (forecast + geocoding, no key)          "weather in Denpasar", "kal baarish hogi?"
//   currency  -> Frankfurter (ECB rates, no key)                    "100 usd to inr", "rupiah rate"
//   search    -> Google News RSS + Wikipedia, plus Brave Search API if BRAVE_API_KEY is set
//                "latest iphone news", "who won the match yesterday", "search best laptops 2026"
// Weather and currency are answered by code (exact numbers). Search results go to the model as
// numbered evidence; the code appends the source links, so the model can't invent them.
import { toQuery } from '../verify/index.js';

const UA = 'PocketAI/1.0 (on-device WhatsApp assistant; https://github.com/bhanage-viraj/pocket-ai)';

const WEATHER_RE = /\b(weather|mausam|temperature|forecast|rain(ing|y)?|baarish|barish|humidity)\b/i;
const SEARCH_RE =
  /^(search|google|look ?up|find out)\b|\b(latest|news|khabar|headlines?|currently|recent(ly)?|this (week|month|year)|who won|kaun jeeta|score|results? of|released?|launch(ed|es)?|price of|kitne ka|kitne ki|share price|stock price|update on|what happened|kya hua|is .{2,30} (dead|alive|still)|20(2[5-9]|3\d))\b/i;

const CUR = [
  ['USD', /(\$|\b(usd|dollars?)\b)/i], ['INR', /(₹|\b(inr|rupees?|rs)\b)/i], ['IDR', /\b(idr|rupiah|rp)\b/i],
  ['EUR', /(€|\b(eur|euros?)\b)/i], ['GBP', /(£|\b(gbp)\b)/i], ['SGD', /\bsgd\b/i], ['AUD', /\baud\b/i],
  ['JPY', /\b(jpy|yen)\b/i], ['AED', /\b(aed|dirhams?)\b/i], ['THB', /\b(thb|baht)\b/i], ['MYR', /\b(myr|ringgit)\b/i],
];

/** "100 usd to inr" -> {amount, from, to}; null if it's not a conversion. Exported for tests. */
export function parseCurrency(text) {
  const s = String(text);
  const found = [];
  for (const [code, re] of CUR) {
    const m = re.exec(s);
    if (m) found.push({ code, at: m.index });
  }
  // two currencies + "to/in" ("100 usd to inr"), or one + "rate/convert/kitne" ("rupiah rate")
  const two = found.length >= 2 && /\b(to|in|into|=)\b/i.test(s);
  if (!two && !(found.length && /\b(rate|convert|exchange|kitne|kitna|how much|worth)\b/i.test(s))) return null;
  found.sort((a, b) => a.at - b.at);
  const amt = /(\d[\d,]*(?:\.\d+)?)\s*(k|lakh|lac|l|cr|crore|m|million|juta|jt)?\b/i.exec(s.replace(/(\d),(\d)/g, '$1$2'));
  const mult = { k: 1e3, lakh: 1e5, lac: 1e5, l: 1e5, cr: 1e7, crore: 1e7, m: 1e6, million: 1e6, juta: 1e6, jt: 1e6 };
  const amount = amt ? parseFloat(amt[1]) * (mult[(amt[2] || '').toLowerCase()] || 1) : 1;
  const from = found[0].code;
  // one currency named ("rupiah rate") -> against INR, or USD if that one is INR
  const to = found[1]?.code ?? (from === 'INR' ? 'USD' : 'INR');
  return from === to ? null : { amount, from, to };
}

/** City from "weather in Kuta Bali tomorrow" / "Denpasar mein mausam". Exported for tests. */
export function parseCity(text) {
  const s = String(text).replace(/[?!.]+$/g, '').trim();
  const tail = '(?:\\s+(?:today|tomorrow|tonight|now|right now|this week|kal|aaj|abhi))*$';
  const m = new RegExp(`\\b(?:in|at|for|of)\\s+([A-Za-z][A-Za-z .,'-]{1,40}?)${tail}`, 'i').exec(s)
    || /^([A-Za-z][A-Za-z .'-]{1,30}?)\s+(?:mein|me|ka|ki|mai)\s+(?:weather|mausam|temperature|baarish|barish)/i.exec(s);
  const city = m?.[1]?.trim();
  return city && !WEATHER_RE.test(city) && !/^(the|my|here|there|today|tomorrow)$/i.test(city) ? city : null;
}

/** Which kind of live lookup a chat message needs, or null. */
export function needsWeb(text) {
  const s = String(text || '');
  if (parseCurrency(s)) return 'currency';
  if (/\b(weather|mausam|forecast)\b/i.test(s)) return 'weather';
  if (WEATHER_RE.test(s) && /\b(today|tomorrow|tonight|kal|aaj|now|abhi|hoga|hogi|will it|is it|outside)\b/i.test(s)) return 'weather';
  if (SEARCH_RE.test(s)) return 'search';
  return null;
}

const WMO = {
  0: '☀️ clear', 1: '🌤️ mostly clear', 2: '⛅ partly cloudy', 3: '☁️ cloudy', 45: '🌫️ fog', 48: '🌫️ fog',
  51: '🌦️ light drizzle', 53: '🌦️ drizzle', 55: '🌧️ heavy drizzle', 61: '🌦️ light rain', 63: '🌧️ rain', 65: '🌧️ heavy rain',
  80: '🌦️ showers', 81: '🌧️ showers', 82: '⛈️ heavy showers', 95: '⛈️ thunderstorm', 96: '⛈️ thunderstorm + hail', 99: '⛈️ thunderstorm + hail',
};
const wmo = (c) => WMO[c] || '🌡️';

export function createWeb({ config = {}, fetchImpl = fetch, search: extra = {} } = {}) {
  const cityByChat = new Map();

  async function get(url, { type = 'json', headers = {} } = {}) {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return type === 'json' ? res.json() : res.text();
  }

  /** "Kuta Bali" -> Open-Meteo knows "Kuta"; anything else -> OpenStreetMap Nominatim. */
  async function geocode(city) {
    const words = city.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    for (const name of [...new Set([city.split(',')[0].trim(), words[0]])]) {
      const hit = (await get(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(name)}`)).results?.[0];
      if (hit && (name === words.join(' ') || words.length === 1 || new RegExp(words.slice(1).join('|'), 'i').test(`${hit.admin1} ${hit.admin2} ${hit.country}`))) return hit;
    }
    const [n] = await get(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(city)}`);
    return n ? { name: n.name || city, admin1: n.display_name.split(',').slice(-3, -2)[0]?.trim(), latitude: +n.lat, longitude: +n.lon } : null;
  }

  async function weather(text, chatId) {
    const city = parseCity(text) || cityByChat.get(chatId) || config.defaultCity;
    if (!city) return '🌦️ Which city? e.g. _weather in Denpasar_';
    const g = await geocode(city);
    if (!g) return `🌦️ I couldn't find a city called "${city}".`;
    cityByChat.set(chatId, city);
    const f = await get(
      `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&timezone=auto&forecast_days=2` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    );
    const c = f.current;
    const day = (i, label) =>
      `*${label}:* ${wmo(f.daily.weather_code[i])}, ${Math.round(f.daily.temperature_2m_min[i])}–${Math.round(f.daily.temperature_2m_max[i])}°C, rain chance ${f.daily.precipitation_probability_max[i] ?? '?'}%`;
    return [
      `🌦️ *${g.name}${g.admin1 ? ', ' + g.admin1 : ''}* right now: ${wmo(c.weather_code)}, *${Math.round(c.temperature_2m)}°C* (feels ${Math.round(c.apparent_temperature)}°C), humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h`,
      day(0, 'Today'),
      day(1, 'Tomorrow'),
      '_Open-Meteo_',
    ].join('\n');
  }

  async function currency(text) {
    const q = parseCurrency(text);
    if (!q) return null;
    const r = await get(`https://api.frankfurter.dev/v1/latest?from=${q.from}&to=${q.to}`);
    const rate = r.rates?.[q.to];
    if (!rate) return `💱 I don't have a rate for ${q.from} → ${q.to}.`;
    const fmt = (n, code) => `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: n < 10 ? 4 : 2 }).format(n)} ${code}`;
    return `💱 ${fmt(q.amount, q.from)} = *${fmt(q.amount * rate, q.to)}*\n_1 ${q.from} = ${rate} ${q.to} · ECB rate of ${r.date} (Frankfurter)_`;
  }

  async function brave(query) {
    if (!config.braveApiKey) return [];
    const r = await get(`https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json', 'x-subscription-token': config.braveApiKey },
    });
    return (r.web?.results || []).map((x) => ({
      kind: 'web', title: x.title, url: x.url, source: new URL(x.url).hostname.replace(/^www\./, ''),
      text: String(x.description || '').replace(/<[^>]+>/g, ''), date: x.age || '',
    }));
  }

  /** Numbered evidence for the model + the list of sources to show. */
  async function searchEvidence(text) {
    const query = toQuery(text.replace(/^(search|google|look ?up|find out)\b\s*(for|about)?/i, ''));
    if (!query) return null;
    const settled = await Promise.allSettled([brave(query), extra.news?.(query) ?? [], extra.wikipedia?.(query) ?? []]);
    const [web, news, wiki] = settled.map((r) => (r.status === 'fulfilled' ? r.value : []));
    const items = [...web.slice(0, 4), ...news.slice(0, 4), ...wiki.slice(0, 1)];
    if (!items.length) return { query, items, block: '' };
    const today = new Date().toISOString().slice(0, 10);
    const lines = items.map((e, i) =>
      e.kind === 'news' ? `[${i + 1}] News (${e.source || 'news'}, ${e.date}): ${e.title}`
      : e.kind === 'wiki' ? `[${i + 1}] Wikipedia "${e.title}": ${e.text.slice(0, 400)}`
      : `[${i + 1}] ${e.source}: ${e.title}. ${e.text.slice(0, 300)}`);
    const block =
      `WEB RESULTS (searched just now for "${query}", today is ${today}):\n${lines.join('\n')}\n` +
      'Answer the user from these results only, mention the [number] of what you used. ' +
      'If they don\'t answer the question, say you couldn\'t find it. Don\'t list links, they are added for you.';
    return { query, items, block };
  }

  return {
    needsWeb,
    /**
     * @returns {Promise<{direct?: string, block?: string, sources?: object[]}|null>}
     *   direct = finished reply (weather/currency); block = evidence for the chat model
     */
    async lookup(text, { chatId, kind = needsWeb(text) } = {}) {
      if (kind === 'weather') return { direct: await weather(text, chatId) };
      if (kind === 'currency') {
        const direct = await currency(text);
        return direct ? { direct } : null;
      }
      if (kind === 'search') {
        const ev = await searchEvidence(text);
        if (!ev) return null;
        if (!ev.items.length) return { block: `WEB RESULTS: nothing found for "${ev.query}". Tell the user you couldn't find anything online about it.`, sources: [] };
        return { block: ev.block, sources: ev.items };
      }
      return null;
    },
  };
}

/** "Sources:" footer: only the ones the model cited ([2]), else the first 3. */
export function sourcesFooter(answer, sources) {
  if (!sources?.length) return '';
  const cited = [...new Set([...String(answer).matchAll(/\[(\d{1,2})\]/g)].map((m) => +m[1]))].filter((n) => n >= 1 && n <= sources.length);
  const picked = (cited.length ? cited : [1, 2, 3].filter((n) => n <= sources.length)).slice(0, 4);
  return '\n\n🔗 ' + picked.map((n) => `[${n}] ${sources[n - 1].source || sources[n - 1].kind}: ${sources[n - 1].url}`).join('\n🔗 ');
}
