// Classifier prompt. Everything before the final user message is identical for every request,
// so llama.cpp's prompt cache (cache_prompt + a dedicated slot) only processes the new message.
import { extractUrls } from '../util/text.js';

/** Replace URLs with a short placeholder: fewer prompt tokens, less distraction for a 1B model. */
export const forModel = (text) => {
  let s = String(text);
  for (const url of extractUrls(s)) {
    let host = 'link';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {}
    s = s.replace(url, `<link:${host}>`);
  }
  return s.trim().slice(0, 600);
};

export function buildSystemPrompt(tasks) {
  const intents = tasks.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const fieldRules = tasks
    .flatMap((t) => Object.entries(t.fields || {}).map(([k, v]) => `- ${t.name}.${k}: ${v.description}`))
    .join('\n');
  return [
    'You classify WhatsApp messages (English or Hinglish) for an assistant and extract fields.',
    'Output exactly one compact JSON object, nothing else.',
    '',
    'Intents:',
    intents,
    '',
    'Fields:',
    fieldRules,
    '',
    'Only pick a task intent when the user clearly wants that action. Otherwise use "chat".',
  ].join('\n');
}

/** Few-shot turns: user message -> compact JSON. Interleaved across tasks so no task dominates the end. */
export function buildFewShot(tasks) {
  const perTask = tasks.map((t) =>
    t.examples.map((ex) => [
      { role: 'user', content: forModel(ex.text) },
      { role: 'assistant', content: JSON.stringify({ intent: t.name, ...(ex.fields || {}) }) },
    ]),
  );
  const turns = [];
  const maxLen = Math.max(...perTask.map((x) => x.length));
  for (let i = 0; i < maxLen; i++) for (const ex of perTask) if (ex[i]) turns.push(...ex[i]);
  return turns;
}

export function buildMessages(tasks, text) {
  return [
    { role: 'system', content: buildSystemPrompt(tasks) },
    ...buildFewShot(tasks),
    { role: 'user', content: forModel(text) },
  ];
}
