// "find me a good cafe nearby", "atm near Seminyak", "Kuta mein khane ki jagah batao".
// Real places from OpenStreetMap (src/places) instead of letting the chat model invent some.
// No area given -> ask for one; the next short message (or a shared 📍 location) answers it.
import { createPlaces, placeKind, formatPlaces } from '../places/index.js';
import { log } from '../util/log.js';

// Only messages that name a kind of place (or "places/jagah" + "near") go to the intent model:
// generic words like "find", "suggest", "recommend" alone are normal chat and must stay fast.
const PLACE_NOUN =
  /\b(cafes?|caf[eé]s?|coffee shops?|restaurants?|warung|atms?|pharmac(y|ies)|chemists?|hospitals?|clinics?|hotels?|hostels?|supermarkets?|petrol pumps?|gas stations?|beach(es)?|gyms?|laundry|bars?|pubs?)\b/i;
const HINGLISH_FOOD = /\b(khane|khana|khaane|khaana)\b[^.?!]{0,30}\b(jagah|kahan|kaha)\b/i;
const NEAR = /\b(near|nearby|nearest|around|close by|aas ?paas)\b/i;
const VAGUE_PLACE = /\b(places?|jagah|spots?|food|eat)\b/i;

const PENDING_MS = 15 * 60_000;
const LOCATION_MS = 2 * 3_600_000;
const pending = new Map(); // chatId -> {kind, at}
const lastPoint = new Map(); // chatId -> {lat, lon, at}

let places = createPlaces();
/** Tests swap the OSM client. */
export function _setPlaces(p) {
  places = p;
  pending.clear();
  lastPoint.clear();
}

const ASK = (kind) => `📍 Sure, which area should I look for *${kind}* in? Type a place (e.g. _Kuta, Bali_) or send your 📍 location.`;

async function run(kind, q) {
  try {
    const r = await places.search({ kind, ...q });
    if (!r) return `📍 I couldn't find a place called "${q.area}". Try adding the city, e.g. _${q.area}, Bali_.`;
    return formatPlaces(kind, r);
  } catch (err) {
    log.warn(`places search failed: ${err.message}`);
    return '📍 The map service isn\'t answering right now, try again in a minute.';
  }
}

/** A short reply after we asked "which area?" looks like a place name, not a new question. */
const looksLikeArea = (text) => {
  const t = String(text).trim();
  return t.length > 1 && t.length <= 60 && t.split(/\s+/).length <= 6 && !/[?]/.test(t) && !/^\//.test(t);
};

export default {
  name: 'find_places',
  description:
    'User wants real places nearby or in an area: cafes, restaurants, ATMs, pharmacies, hotels, beaches, etc. ' +
    '("find a cafe near X", "atm kahan hai", "restaurants in X"). Not for general questions about food or travel.',
  fields: {
    what: { type: 'string', description: 'the kind of place in 1-3 words, e.g. "cafe", "atm", "restaurant"' },
    where: {
      type: ['string', 'null'],
      description: 'the area/city exactly as the user wrote it, or null if they said "nearby"/"near me" or no place',
      grounded: true,
    },
  },
  examples: [
    { text: 'find me a good cafe nearby', fields: { what: 'cafe', where: null } },
    { text: 'any atm near Seminyak?', fields: { what: 'atm', where: 'Seminyak' } },
    { text: 'Andheri West mein khane ki achhi jagah batao', fields: { what: 'restaurant', where: 'Andheri West' } },
  ],

  prefilter: (text) => PLACE_NOUN.test(text) || HINGLISH_FOOD.test(text) || (NEAR.test(text) && VAGUE_PLACE.test(text)),

  async handle(ctx, fields) {
    const kind = placeKind(fields.what) || 'cafe';
    if (fields.where) return run(kind, { area: fields.where });
    const p = lastPoint.get(ctx.chatId);
    if (p && Date.now() - p.at < LOCATION_MS) return run(kind, { point: { lat: p.lat, lon: p.lon } });
    pending.set(ctx.chatId, { kind, at: Date.now() });
    return ASK(kind);
  },

  /** Called before intent detection: answers our own "which area?" question. undefined = not ours. */
  async followUp(ctx, text) {
    const p = pending.get(ctx.chatId);
    if (!p) return undefined;
    pending.delete(ctx.chatId);
    if (Date.now() - p.at > PENDING_MS || !looksLikeArea(text)) return undefined;
    return run(p.kind, { area: text.replace(/^(in|at|near|around)\s+/i, '') });
  },

  /** A shared 📍 location: answer a pending search, or remember it for "nearby" later. */
  async onLocation(ctx, point) {
    lastPoint.set(ctx.chatId, { ...point, at: Date.now() });
    const p = pending.get(ctx.chatId);
    pending.delete(ctx.chatId);
    if (p && Date.now() - p.at < PENDING_MS) return run(p.kind, { point });
    return '📍 Got your location. Ask me e.g. _cafes nearby_ or _atm near me_ in the next 2 hours and I\'ll search around it.';
  },
};
