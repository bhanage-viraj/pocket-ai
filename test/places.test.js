import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeKind, formatPlaces, createPlaces } from '../src/places/index.js';
import findPlaces, { _setPlaces } from '../src/tasks/find_places.js';
import { createIntentDetector } from '../src/intent/detect.js';
import { loadTasks } from '../src/tasks/index.js';

test('placeKind: what people say -> OSM search word', () => {
  assert.equal(placeKind('good cafe'), 'cafe');
  assert.equal(placeKind('khane ki jagah'), 'restaurant');
  assert.equal(placeKind('ATM'), 'atm');
  assert.equal(placeKind('medical store'), 'pharmacy');
  assert.equal(placeKind('nice surf shop'), 'surf shop');
});

test('OSM client: geocode area, bounded search, real names + map links, no invented ones', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const body = url.includes('q=Kuta')
      ? [{ lat: '-8.72', lon: '115.17', display_name: 'Kuta, Badung, Bali, Indonesia', boundingbox: ['-8.77', '-8.68', '115.15', '115.19'] }]
      : [
          { name: 'Dots Cafe', type: 'cafe', lat: '-8.6867', lon: '115.1672', extratags: {} },
          { name: 'Starbucks', type: 'cafe', lat: '-8.7207', lon: '115.1697', extratags: { cuisine: 'coffee_shop', opening_hours: '07:00-23:00', phone: 'x', brand: 'y' } },
          { name: '', type: 'cafe', lat: '-8.7', lon: '115.1', extratags: {} },
        ];
    return { ok: true, json: async () => body };
  };
  const r = await createPlaces({ fetchImpl, minGapMs: 0 }).search({ kind: 'cafe', area: 'Kuta Bali' });
  assert.match(urls[1], /bounded=1&viewbox=115\.15000,-8\.77000,115\.19000,-8\.68000/);
  assert.deepEqual(r.results.map((x) => x.name), ['Starbucks', 'Dots Cafe']); // better-documented first, unnamed dropped
  const text = formatPlaces('cafe', r);
  assert.match(text, /\*Starbucks\*\n {3}coffee shop · 🕒 07:00-23:00/);
  assert.match(text, /https:\/\/maps\.google\.com\/\?q=-8\.72070,115\.16970/);
  assert.match(text, /no ratings/);
});

test('find_places: "nearby" asks for an area, the next message answers it; a location works too', async () => {
  const calls = [];
  _setPlaces({ search: async (q) => (calls.push(q), { where: q.area || 'your location', results: [] }) });
  const ctx = { chatId: 'c1' };
  assert.match(await findPlaces.handle(ctx, { what: 'good cafe', where: null }), /which area/);
  assert.match(await findPlaces.followUp(ctx, 'Kuta Bali'), /couldn't find any \*cafe\* listed near Kuta Bali/);
  assert.deepEqual(calls[0], { kind: 'cafe', area: 'Kuta Bali' });
  assert.equal(await findPlaces.followUp(ctx, 'thanks'), undefined); // answered once, then normal chat again

  await findPlaces.handle(ctx, { what: 'atm', where: null });
  await findPlaces.onLocation(ctx, { lat: -8.7, lon: 115.1 });
  assert.deepEqual(calls[1], { kind: 'atm', point: { lat: -8.7, lon: 115.1 } });
  await findPlaces.handle(ctx, { what: 'pharmacy', where: null }); // remembered location, no question
  assert.deepEqual(calls[2], { kind: 'pharmacy', point: { lat: -8.7, lon: 115.1 } });

  assert.equal(await findPlaces.followUp({ chatId: 'c2' }, 'Kuta'), undefined); // nothing pending
});

test('save_resource without a link is overruled to chat (no "Saved resource" for "Map links")', async () => {
  const tasks = await loadTasks();
  const llm = { complete: async () => ({ text: '{"intent":"save_resource","project":null,"topic":"map"}', timings: {} }) };
  const det = createIntentDetector({ llm, tasks });
  const r = await det.detect('Map links');
  assert.equal(r.intent, 'chat');
  assert.equal(r.rejected, 'save_resource');
  assert.equal((await det.detect('map links https://maps.app.goo.gl/abc')).intent, 'save_resource');
});
