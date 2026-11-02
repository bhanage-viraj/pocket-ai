import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { decide } from '../src/core/router.js';
import { loadTasks } from '../src/tasks/index.js';
import { loadCommands } from '../src/commands/index.js';
import { toQuery, parseNewsRss, createVerifier, formatVerdict } from '../src/verify/index.js';

const commands = await loadCommands(await loadTasks());
const d = (m) => decide(m, { config, commands });
const msg = (over = {}) => ({
  id: '1', chatId: 'g@g.us', isGroup: true, text: '', timestamp: 0, mentionsBot: false, repliesToBot: false,
  sender: { jid: 'r', number: '919822222222', name: 'Rahul' }, ...over,
});

test('routing: reply + "@Pocket verify this", /verify, "fact check:", "sach hai kya" in DMs', () => {
  const r = d(msg({ text: 'verify this', mentionsBot: true, quoted: { text: 'Govt is giving free laptops to all students', id: 'q' } }));
  assert.equal(r.name, 'verify', 'must not become a normal quoted-message chat');
  assert.equal(d(msg({ text: '/verify the moon landing was faked' })).name, 'verify');
  assert.equal(d(msg({ text: 'verify this' })).action, 'ignore', 'untagged group chatter stays ignored');
  const dm = { isGroup: false, chatId: '9198@s.whatsapp.net', sender: { number: '919811111111', name: 'Owner' } };
  assert.equal(d(msg({ ...dm, text: 'fact check: India won the 2011 world cup' })).argText, 'India won the 2011 world cup');
  assert.equal(d(msg({ ...dm, text: 'sach hai kya ki petrol free hoga' })).name, 'verify');
});

test('claim -> keywords', () => {
  assert.equal(toQuery('Is it true that the Eiffel Tower is 330 metres tall?'), 'eiffel tower 330 metres tall');
  assert.equal(toQuery('bhai kya ye sach hai ki RBI ne 2000 ke note band kar diye'), 'rbi 2000 note band kar diye');
});

const RSS = `<rss><channel><item><title>RBI withdraws Rs 2000 notes from circulation - The Hindu</title>
<link>https://news.google.com/rss/articles/abc</link><pubDate>Fri, 19 May 2023 12:00:00 GMT</pubDate>
<source url="https://www.thehindu.com">The Hindu</source></item></channel></rss>`;

test('Google News RSS parsing', () => {
  assert.deepEqual(parseNewsRss(RSS), [{ kind: 'news', title: 'RBI withdraws Rs 2000 notes from circulation', url: 'https://news.google.com/rss/articles/abc', source: 'The Hindu', date: '2023-05-19' }]);
});

function fakeFetch({ wiki = true, news = true } = {}) {
  return async (url) => {
    const ok = (body, json = true) => ({ ok: true, status: 200, json: async () => body, text: async () => (json ? JSON.stringify(body) : body) });
    if (url.includes('list=search')) return wiki ? ok({ query: { search: [{ title: '2000 rupee note', snippet: 'the <b>note</b>' }] } }) : ok({ query: { search: [] } });
    if (url.includes('rest_v1/page/summary')) return ok({ extract: 'In May 2023 the RBI announced the withdrawal of the ₹2000 note from circulation.' });
    if (url.includes('news.google.com')) return news ? ok(RSS, false) : ok('<rss></rss>', false);
    throw new Error(`unexpected ${url}`);
  };
}
const fakeLlm = (out) => ({ complete: async ({ messages }) => ({ text: JSON.stringify(typeof out === 'function' ? out(messages) : out) }) });

test('verdict uses numbered evidence and shows sources', async () => {
  let prompt = '';
  const v = createVerifier({ fetchImpl: fakeFetch(), llm: fakeLlm((m) => ((prompt = m[1].content), { verdict: 'true', reason: 'RBI withdrew the note in 2023.', cited: [1, 2] })) });
  const r = await v.verify('RBI ne 2000 ke note band kar diye');
  assert.equal(r.verdict, 'true');
  assert.match(prompt, /\[1\] Wikipedia "2000 rupee note": In May 2023/);
  assert.match(prompt, /\[2\] News headline \(The Hindu, 2023-05-19\): RBI withdraws/);
  const text = formatVerdict('RBI ne 2000 ke note band kar diye', r);
  assert.match(text, /Verdict: ✅ \*True\*/);
  assert.match(text, /1\. Wikipedia: 2000 rupee note\nhttps:\/\/en\.wikipedia\.org\/wiki\/2000_rupee_note/);
  assert.match(text, /Read the sources before forwarding/);
});

test('safety: a confident verdict with no cited evidence becomes Unverified; no sources -> Unverified without asking the model', async () => {
  const lazy = createVerifier({ fetchImpl: fakeFetch(), llm: fakeLlm({ verdict: 'false', reason: 'Nope.', cited: [] }) });
  assert.equal((await lazy.verify('RBI ne 2000 ke note band kar diye')).verdict, 'unverified');
  const bogus = createVerifier({ fetchImpl: fakeFetch(), llm: fakeLlm({ verdict: 'false', reason: 'x', cited: [9] }) });
  assert.equal((await bogus.verify('RBI ne 2000 ke note band kar diye')).verdict, 'unverified', 'out-of-range citations don\'t count');
  let called = false;
  const empty = createVerifier({ fetchImpl: fakeFetch({ wiki: false, news: false }), llm: { complete: async () => { called = true; } } });
  const r = await empty.verify('some totally obscure local claim xyz');
  assert.equal(r.verdict, 'unverified');
  assert.equal(called, false);
});
