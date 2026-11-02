// Sticker maker: photo / GIF / sticker + a prompt -> WhatsApp sticker (512x512 WebP, transparent).
//   "sticker"                          -> plain sticker
//   "sticker with text 'Monday mood'"  -> caption at the bottom
//   "round sticker, top text: chai time, yellow" -> circle crop, text on top, yellow
// GIFs become animated stickers. The prompt is turned into a small spec by the model
// (grammar-constrained JSON), with a plain-code fallback, then ffmpeg renders it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { SLOTS } from '../llm/client.js';
import { MediaUnavailableError } from '../media/index.js';

export const STICKER_RE = /\b(sticker|stiker|stkr)\b/i;
const COLORS = ['white', 'yellow', 'black', 'red', 'green', 'blue', 'pink', 'orange', 'purple', 'cyan'];

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: ['string', 'null'] },
    position: { enum: ['top', 'bottom', 'center'] },
    color: { enum: COLORS },
    shape: { enum: ['square', 'circle', 'rounded'] },
  },
  required: ['text', 'position', 'color', 'shape'],
};

const SPEC_PROMPT = `Turn a WhatsApp sticker request into JSON.
text: the exact words to write ON the sticker (only if the user asks for text/caption/likh; keep their language), else null.
position: top | bottom | center (default bottom). color: text color (default white).
shape: circle if they say round/circle/gol, rounded for rounded corners, else square.
Examples:
"sticker" -> {"text":null,"position":"bottom","color":"white","shape":"square"}
"sticker bana do with text 'Monday mood'" -> {"text":"Monday mood","position":"bottom","color":"white","shape":"square"}
"round sticker, upar likho chai time in yellow" -> {"text":"chai time","position":"top","color":"yellow","shape":"circle"}`;

/** Plain-code reading of the prompt: used as fallback and to keep the model honest. */
export function ruleSpec(prompt) {
  const p = String(prompt || '');
  const quoted = /["“'‘]([^"”'’]{1,60})["”'’]/.exec(p)?.[1];
  const after = /\b(?:text|caption|likho|likh do|likh|write|saying|that says)\s*[:\-]?\s*(.{1,60})$/i.exec(p)?.[1];
  let text = (quoted || after || '').trim().replace(/\s+(in|with)\s+(white|yellow|black|red|green|blue|pink|orange|purple|cyan)\b.*$/i, '').trim() || null;
  if (text && STICKER_RE.test(text) && !quoted) text = null;
  const lower = p.toLowerCase();
  return {
    text,
    position: /\b(top|upar|uper)\b/.test(lower) ? 'top' : /\b(center|centre|middle|beech)\b/.test(lower) ? 'center' : 'bottom',
    color: COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(lower)) || 'white',
    shape: /\b(round|circle|gol)\b/.test(lower) ? 'circle' : /\brounded\b/.test(lower) ? 'rounded' : 'square',
  };
}

function exec(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (err?.code === 'ENOENT') reject(new MediaUnavailableError(`${bin} not installed`));
      else if (err) reject(Object.assign(err, { message: `ffmpeg failed: ${String(stderr).trim().split('\n').pop()}` }));
      else resolve();
    });
  });
}

/** ffmpeg filter graph for a spec. Exported for tests. */
export function buildFilter(spec, { animated, fontFile, textFile }) {
  // square: fit the whole picture (transparent bars); circle/rounded: fill the square (centre crop)
  const fill = spec.shape === 'circle' || spec.shape === 'rounded';
  const f = [
    ...(animated ? ['fps=12'] : []),
    ...(fill
      ? ['scale=512:512:force_original_aspect_ratio=increase', 'crop=512:512', 'format=rgba']
      : ['scale=512:512:force_original_aspect_ratio=decrease', 'format=rgba', 'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000']),
  ];
  if (spec.shape === 'circle') {
    f.push("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-256,Y-256),254),alpha(X,Y),0)'");
  } else if (spec.shape === 'rounded') {
    // corners of radius 60 cut out
    f.push("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(abs(X-256),196)*gt(abs(Y-256),196)*gt(hypot(abs(X-256)-196,abs(Y-256)-196),60),0,alpha(X,Y))'");
  }
  if (spec.text && textFile) {
    const edge = fill ? 44 : 24; // keep text inside the circle's curve
    const y = spec.position === 'top' ? String(edge) : spec.position === 'center' ? '(h-text_h)/2' : `h-text_h-${edge + 4}`;
    const size = spec.text.length > 22 ? 40 : spec.text.length > 12 ? 52 : 64;
    f.push(
      `drawtext=fontfile=${fontFile}:textfile=${textFile}:fontsize=${size}:fontcolor=${spec.color}` +
        `:borderw=5:bordercolor=black@0.85:x=(w-text_w)/2:y=${y}`,
    );
  }
  return f.join(',');
}

export function createStickerMaker({ config, llm }) {
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = (ext) => path.join(tmpDir, `st-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);

  async function spec(prompt) {
    const rules = ruleSpec(prompt);
    if (!llm) return rules;
    try {
      const r = await llm.complete({
        messages: [{ role: 'system', content: SPEC_PROMPT }, { role: 'user', content: String(prompt || 'sticker') }],
        jsonSchema: SPEC_SCHEMA, maxTokens: 60, temperature: 0, slot: SLOTS.intent,
      });
      const m = JSON.parse(r.text);
      // the model may invent text; only trust it if those words were really in the prompt
      const text = m.text && String(prompt).toLowerCase().includes(String(m.text).toLowerCase().trim()) ? m.text.trim() : rules.text;
      return { ...rules, ...m, text: text || null };
    } catch {
      return rules;
    }
  }

  async function render(buffer, kind, s) {
    const animated = kind === 'gif';
    const input = tmp(animated ? 'mp4' : kind === 'sticker' ? 'webp' : 'jpg');
    const out = tmp('webp');
    const textFile = s.text ? tmp('txt') : null;
    fs.writeFileSync(input, buffer);
    if (textFile) fs.writeFileSync(textFile, s.text.slice(0, 60));
    try {
      const vf = buildFilter(s, { animated, fontFile: config.stickerFont, textFile });
      const args = ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-vf', vf];
      args.push(...(animated
        ? ['-t', '6', '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', '45', '-an']
        : ['-frames:v', '1', '-c:v', 'libwebp', '-q:v', '80']), out);
      await exec(config.ffmpegBin, args, 90_000);
      return fs.readFileSync(out);
    } finally {
      for (const f of [input, out, textFile]) if (f) fs.rm(f, { force: true }, () => {});
    }
  }

  return {
    /** @returns {Promise<{webp: Buffer, spec: object}>} */
    async make(buffer, kind, prompt) {
      const s = await spec(prompt);
      return { webp: await render(buffer, kind, s), spec: s };
    },
    spec,
  };
}
