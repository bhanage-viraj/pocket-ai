// Task registry. A task = one file in this folder that default-exports:
//
//   name         unique snake_case id; becomes the "intent" value the model outputs
//   description  one line for the classifier prompt (what messages belong to this task)
//   fields       JSON-schema `properties` the model must extract (order = generation order).
//                Extra key `grounded: true` = value must appear in the message, else it is nulled.
//   examples     few-shot examples: [{ text, fields }]   (English + Hinglish)
//   prefilter    optional (text) => boolean; cheap check, false = "definitely not this task"
//   postprocess  optional (fields, text) => fields; plain-code cleanup/fallbacks after grounding
//   permission   'anyone' (default) | 'owner'
//   migrate      optional (db) => void; create the task's tables
//   handle       async (ctx, fields) => reply text
//   commands     optional array of commands this task adds (e.g. /res to list saved resources)
//
// `chat` is the fallback task: it has no handler, the router sends it to the chat model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

function validate(task, file) {
  const problems = [];
  if (!/^[a-z][a-z0-9_]*$/.test(task?.name || '')) problems.push('name must be snake_case');
  if (!task.description) problems.push('missing description');
  if (!Array.isArray(task.examples) || !task.examples.length) problems.push('needs at least one example');
  if (task.name !== 'chat' && typeof task.handle !== 'function') problems.push('missing handle()');
  for (const ex of task.examples || []) {
    for (const key of Object.keys(ex.fields || {})) {
      if (!task.fields?.[key]) problems.push(`example field "${key}" not declared in fields`);
    }
  }
  if (problems.length) throw new Error(`Invalid task in ${file}: ${problems.join('; ')}`);
}

/** Load all tasks. `only` = optional list of task names (chat is always included). */
export async function loadTasks({ only } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort();
  const tasks = [];
  for (const file of files) {
    const task = (await import(pathToFileURL(path.join(dir, file)).href)).default;
    validate(task, file);
    if (only && task.name !== 'chat' && !only.includes(task.name)) continue;
    tasks.push({ permission: 'anyone', fields: {}, commands: [], ...task });
  }
  if (!tasks.some((t) => t.name === 'chat')) throw new Error('The chat task is required');
  // chat last: it is the fallback
  return [...tasks.filter((t) => t.name !== 'chat'), tasks.find((t) => t.name === 'chat')];
}
