// "Model proposes, code verifies." Small models invent values (e.g. a project the user never
// mentioned). A grounded field is kept only if its words appear in the message:
//   grounded: true  -> every word must appear (names, projects)
//   grounded: 0.7   -> at least 70% of the words must appear (free text like a note)
import { stripUrls } from '../util/text.js';

const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const STOP = new Set(['the', 'my', 'a', 'an', 'for', 'of', 'project', 'ke', 'ka', 'ki', 'liye']);

export function isGrounded(value, text, minFraction = 1) {
  const haystack = new Set(words(stripUrls(text)));
  const needles = words(value).filter((w) => !STOP.has(w));
  if (!needles.length) return false;
  const found = needles.filter((w) => haystack.has(w)).length;
  return found / needles.length >= minFraction;
}

/** Null out grounded fields whose value is not supported by the message text. */
export function groundFields(task, fields, text) {
  const out = { ...fields };
  for (const [name, spec] of Object.entries(task.fields || {})) {
    if (!spec.grounded || out[name] == null) continue;
    const min = spec.grounded === true ? 1 : Number(spec.grounded);
    if (!isGrounded(out[name], text, min)) out[name] = null;
  }
  return out;
}
