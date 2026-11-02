import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsWeb, parseCurrency, parseCity, createWeb, sourcesFooter } from '../src/web/index.js';

test('needsWeb: live questions yes, normal chat no', () => {
  for (const [t, k] of [
    ['weather in Denpasar', 'weather'], ['kal baarish hogi kya?', 'weather'], ['will it rain tomorrow', 'weather'],
    ['100 usd to inr', 'currency'], ['rupiah rate kitna hai', 'currency'], ['5 lakh rupiah in rupees', 'currency'],
    ['latest iphone news', 'search'], ['who won the match yesterday', 'search'], ['search best budget laptops', 'search'],
    ['what happened in Nepal', 'search'],
    ['hi how are you', null], ['I have a cold today', null], ['explain recursion in python', null],
    ['I am in Bali with my friends', null], ['purple rain is a great song', null],
  ]) assert.equal(needsWeb(t), k, t);
});

test('parseCurrency / parseCity', () => {
  assert.deepEqual(parseCurrency('100 usd to inr'), { amount: 100, from: 'USD', to: 'INR' });
  assert.deepEqual(parseCurrency('5 lakh rupiah in rupees'), { amount: 500000, from: 'IDR', to: 'INR' });
  assert.deepEqual(parseCurrency('$1,250 in rupiah'), { amount: 1250, from: 'USD', to: 'IDR' });
  assert.deepEqual(parseCurrency('rupiah rate'), { amount: 1, from: 'IDR', to: 'INR' });
  assert.equal(parseCity('weather in Kuta Bali tomorrow?'), 'Kuta Bali');
  assert.equal(parseCity('Mumbai mein mausam kaisa hai'), 'Mumbai');
  assert.equal(parseCity('how is the weather today'), null);
});

const fakeFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => url.includes(k));
  if (!hit) throw new Error('unexpected ' + url);
  return { ok: true, json: async () => hit[1], text: async () => hit[1] };
};

test('weather and currency are answered by code with exact numbers', async () => {
  const web = createWeb({
    fetchImpl: fakeFetch({
      'geocoding-api': { results: [{ name: 'Denpasar', admin1: 'Bali', latitude: -8.65, longitude: 115.2 }] },
      'api.open-meteo.com': {
        current: { temperature_2m: 27.7, apparent_temperature: 31.2, relative_humidity_2m: 80, weather_code: 0, wind_speed_10m: 8 },
        daily: { weather_code: [61, 3], temperature_2m_min: [24, 24.4], temperature_2m_max: [31, 30.6], precipitation_probability_max: [70, 20] },
      },
      frankfurter: { date: '2026-10-30', rates: { INR: 94.95 } },
    }),
  });
  const w = await web.lookup('weather in Denpasar', { chatId: 'c' });
  assert.match(w.direct, /Denpasar, Bali\* right now: ☀️ clear, \*28°C\*/);
  assert.match(w.direct, /Today:\* 🌦️ light rain, 24–31°C, rain chance 70%/);
  assert.match((await web.lookup('and tomorrow? will it rain', { chatId: 'c' })).direct, /Denpasar/); // city remembered
  assert.match((await web.lookup('100 usd to inr')).direct, /100 USD = \*9,495 INR\*/);
});

test('search: numbered evidence for the model, links added by code from what it cited', async () => {
  const web = createWeb({ search: { news: async () => [{ kind: 'news', title: 'X wins final', source: 'ESPN', date: '2026-11-01', url: 'https://g/x' }], wikipedia: async () => [] } });
  const r = await web.lookup('who won the final yesterday');
  assert.match(r.block, /\[1\] News \(ESPN, 2026-11-01\): X wins final/);
  assert.equal(sourcesFooter('X won it [1].', r.sources), '\n\n🔗 [1] ESPN: https://g/x');
  assert.equal(sourcesFooter('no idea', []), '');
});
