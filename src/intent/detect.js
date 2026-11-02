// Stage 1 of every AI message: decide the intent and extract fields.
//   1. prefilter (plain code): if no task's keyword/URL check matches -> chat, no model call
//   2. one grammar-constrained call to the small model -> guaranteed-valid JSON
import { SLOTS } from '../llm/client.js';
import { buildIntentSchema } from './schema.js';
import { buildMessages } from './prompt.js';
import { groundFields } from './ground.js';

export function createIntentDetector({ llm, tasks, prefilter = true, onGeneration = () => {} }) {
  const schema = buildIntentSchema(tasks);
  const taskByName = new Map(tasks.map((t) => [t.name, t]));
  const actionTasks = tasks.filter((t) => t.name !== 'chat');

  /** @returns {Promise<{intent: string, fields: object, via: 'prefilter'|'model'|'fallback', ms: number}>} */
  async function detect(text) {
    const t0 = performance.now();
    if (prefilter && actionTasks.every((t) => t.prefilter && !t.prefilter(text))) {
      return { intent: 'chat', fields: {}, via: 'prefilter', ms: performance.now() - t0 };
    }

    const result = await llm.complete({
      messages: buildMessages(tasks, text),
      jsonSchema: schema,
      maxTokens: 96,
      temperature: 0,
      slot: SLOTS.intent,
    });
    onGeneration('intent', result);

    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return { intent: 'chat', fields: {}, via: 'fallback', ms: performance.now() - t0, raw: result.text };
    }
    const { intent, ...raw } = parsed;
    const task = taskByName.get(intent);
    if (!task) return { intent: 'chat', fields: {}, via: 'fallback', ms: performance.now() - t0 };
    // a task can refuse messages it can't act on (e.g. "save" with no link in it) -> plain chat
    if (task.accepts && !task.accepts(text)) return { intent: 'chat', fields: {}, via: 'rejected', ms: performance.now() - t0, rejected: intent };
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') raw[k] = v.trim() || null;
    }
    let fields = groundFields(task, raw, text);
    if (task.postprocess) fields = task.postprocess(fields, text);
    return { intent, fields, via: 'model', ms: performance.now() - t0, timings: result.timings };
  }

  return { detect, schema };
}
