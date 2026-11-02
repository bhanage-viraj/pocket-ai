import { normalizeKey } from '../src/util/text.js';

// Field matchers for eval datasets. Expected value:
//   null                       -> output must be null/empty
//   "text"                     -> normalized equality ("Pocket AI" == "pocket-ai")
//   {"any": ["a","b"]}         -> normalized equality with any
//   {"contains": ["a","b"]}    -> normalized output contains any of them
export function matchField(expected, actual) {
  const a = actual == null ? '' : normalizeKey(actual);
  if (expected === null) return a === '';
  if (typeof expected === 'string') return a === normalizeKey(expected);
  if (expected.any) return expected.any.some((e) => a === normalizeKey(e));
  if (expected.contains) return a !== '' && expected.contains.some((e) => a.includes(normalizeKey(e)));
  throw new Error(`bad matcher ${JSON.stringify(expected)}`);
}
