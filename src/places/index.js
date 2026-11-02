// Real places, not made-up ones: "cafes in Kuta Bali", "atm near Seminyak", or a shared 📍 location.
// Free + open data: OpenStreetMap via Nominatim (geocode the area, then a bounded search for the
// kind of place). No ratings exist in OSM, so we say so instead of pretending something is "good".
// Nominatim policy: identify with a User-Agent and keep to ~1 request/second.

const UA = 'PocketAI/1.0 (on-device WhatsApp assistant; https://github.com/bhanage-viraj/pocket-ai)';
const BASE = 'https://nominatim.openstreetmap.org';
const RADIUS_DEG = 0.015; // ~1.6 km around a point

// what people say -> what OSM calls it
const SYNONYMS = [
  [/\b(cafes?|caf[eé]s?|coffee( shops?)?|kopi)\b/i, 'cafe'],
  [/\b(restaurants?|food|khana|khaana|khane|khaane|eat(ing)?|dinner|lunch|breakfast|warung)\b/i, 'restaurant'],
  [/\b(fast ?food|burger|pizza)\b/i, 'fast food'],
  [/\b(bars?|pubs?|beer|drinks?)\b/i, 'bar'],
  [/\b(atms?|cash)\b/i, 'atm'],
  [/\b(banks?)\b/i, 'bank'],
  [/\b(pharmac(y|ies)|chemists?|medical( store)?|medicine|dawai|dawa|apotek)\b/i, 'pharmacy'],
  [/\b(hospitals?|clinics?|doctor)\b/i, 'hospital'],
  [/\b(hotels?|stay|hostels?)\b/i, 'hotel'],
  [/\b(supermarkets?|grocery|groceries|minimart|indomaret|alfamart)\b/i, 'supermarket'],
  [/\b(petrol|fuel|gas station|pump)\b/i, 'fuel'],
  [/\b(beach(es)?)\b/i, 'beach'],
  [/\b(gyms?|fitness)\b/i, 'gym'],
  [/\b(laundry)\b/i, 'laundry'],
  [/\b(temples?|mandir)\b/i, 'temple'],
  [/\b(mosques?|masjid)\b/i, 'mosque'],
  [/\b(toilets?|washroom|restroom)\b/i, 'toilets'],
];

/** Free text ("good cafe", "kuch khane ki jagah") -> an OSM search word, or the text itself. */
export function placeKind(what) {
  const s = String(what || '');
  for (const [re, kind] of SYNONYMS) if (re.test(s)) return kind;
  return s.trim().toLowerCase().replace(/\b(good|best|nice|nearby|near me|some|any|a|the|places?|jagah)\b/g, '').replace(/\s+/g, ' ').trim() || null;
}

const mapsLink = (lat, lon) => `https://maps.google.com/?q=${(+lat).toFixed(5)},${(+lon).toFixed(5)}`;

export function createPlaces({ fetchImpl = fetch, minGapMs = 1100 } = {}) {
  let last = 0;
  async function get(pathAndQuery) {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetchImpl(`${BASE}${pathAndQuery}`, { headers: { 'user-agent': UA, 'accept-language': 'en' }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from nominatim`);
    return res.json();
  }

  /** "Kuta Bali" -> {name, lat, lon, box:[w,s,e,n]} or null */
  async function geocode(area) {
    const [hit] = await get(`/search?format=jsonv2&limit=1&q=${encodeURIComponent(area)}`);
    if (!hit) return null;
    const [s, n, w, e] = (hit.boundingbox || []).map(Number);
    // a whole island/country is too big to search in; a single building too small -> use a radius
    const ok = [s, n, w, e].every(Number.isFinite) && n - s < 0.12 && e - w < 0.12 && n - s > 0.004;
    const lat = +hit.lat;
    const lon = +hit.lon;
    return { name: hit.display_name.split(',').slice(0, 2).join(','), lat, lon, box: ok ? [w, s, e, n] : around(lat, lon) };
  }

  const around = (lat, lon) => [lon - RADIUS_DEG, lat - RADIUS_DEG, lon + RADIUS_DEG, lat + RADIUS_DEG];

  /**
   * @param {{kind: string, area?: string, point?: {lat:number, lon:number}}} q
   * @returns {Promise<{where: string, results: object[]}|null>} null = area not found
   */
  async function search({ kind, area, point }) {
    let where;
    let box;
    let center;
    if (point) {
      where = 'your location';
      center = point;
      box = around(point.lat, point.lon);
    } else {
      const g = await geocode(area);
      if (!g) return null;
      ({ name: where, box } = g);
      center = g;
    }
    const rows = await get(`/search?format=jsonv2&limit=15&extratags=1&bounded=1&viewbox=${box.map((x) => x.toFixed(5)).join(',')}&q=${encodeURIComponent(kind)}`);
    const results = rows
      .filter((r) => r.name)
      .map((r) => {
        const t = r.extratags || {};
        return {
          name: r.name,
          type: r.type,
          lat: +r.lat,
          lon: +r.lon,
          km: distKm(center, { lat: +r.lat, lon: +r.lon }),
          hours: t.opening_hours || null,
          cuisine: t.cuisine ? t.cuisine.split(';').slice(0, 3).join(', ').replace(/_/g, ' ') : null,
          website: t.website || t['contact:website'] || null,
          info: Object.keys(t).length, // more tags = better-documented place
          link: mapsLink(r.lat, r.lon),
        };
      });
    // nearest first, with a small bonus for well-documented places (a weak stand-in for "popular")
    const score = (r) => r.km - 0.3 * Math.min(r.info, 4);
    results.sort((a, b) => score(a) - score(b));
    return { where, results: dedupe(results).slice(0, 6) };
  }

  return { search, geocode };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => !seen.has(r.name.toLowerCase()) && seen.add(r.name.toLowerCase()));
}

function distKm(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** WhatsApp message for search results. */
export function formatPlaces(kind, { where, results }) {
  if (!results.length) {
    return `📍 I couldn't find any *${kind}* listed near ${where} on OpenStreetMap. Try a nearby area name, or send your 📍 location.`;
  }
  const lines = results.map((r, i) => {
    const extra = [r.cuisine, r.hours && `🕒 ${r.hours}`, r.km >= 0.05 && `${r.km < 1 ? Math.round(r.km * 1000) + ' m' : r.km.toFixed(1) + ' km'}`].filter(Boolean).join(' · ');
    return `${i + 1}. *${r.name}*${extra ? `\n   ${extra}` : ''}\n   ${r.link}`;
  });
  return [
    `📍 *${kind[0].toUpperCase() + kind.slice(1)}* near ${where}:`,
    '',
    ...lines,
    '',
    '_From OpenStreetMap (no ratings there), open the link for reviews & photos._',
  ].join('\n');
}
