// Try the sticker maker without WhatsApp:  node src/dev/sticker.js <image|gif.mp4> "<prompt>" [out.webp]
// Uses the plain-code prompt reading (no model needed).
import fs from 'node:fs';
import { config } from '../config.js';
import { createStickerMaker } from '../stickers/index.js';

const [input, prompt = 'sticker', out = 'sticker.webp'] = process.argv.slice(2);
if (!input) {
  console.log('usage: node src/dev/sticker.js <image|gif.mp4> "<prompt>" [out.webp]');
  process.exit(1);
}
const kind = /\.(mp4|gif)$/i.test(input) ? 'gif' : /\.webp$/i.test(input) ? 'sticker' : 'image';
const t0 = performance.now();
const { webp, spec } = await createStickerMaker({ config, llm: null }).make(fs.readFileSync(input), kind, prompt);
fs.writeFileSync(out, webp);
console.log(`${out}: ${Math.round(webp.length / 1024)} KB in ${Math.round(performance.now() - t0)} ms`, spec);
