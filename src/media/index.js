// Turns voice notes, GIFs, stickers and photos into text the chat model can answer, all on the phone:
//   voice -> ffmpeg (16 kHz wav) -> whisper.cpp (whisper-cli) -> transcript
//   gif / sticker / photo -> ffmpeg (one frame, small jpeg) -> small vision model (llama-server
//                            with --mmproj, see scripts/run-vision.sh) -> one-line description
// Every step degrades gracefully: missing tool / model / server -> a plain "[sent a GIF]" text.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { log } from '../util/log.js';

const LABEL = { gif: 'a GIF', sticker: 'a sticker', image: 'a photo' };

function exec(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr).slice(0, 300) }));
      else resolve(String(stdout));
    });
  });
}

export function createMedia({ config }) {
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = (ext) => path.join(tmpDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
  const cleanup = (...files) => files.forEach((f) => fs.rm(f, { force: true }, () => {}));

  async function transcribe(buffer) {
    const input = tmp('ogg');
    const wav = tmp('wav');
    fs.writeFileSync(input, buffer);
    try {
      await exec(config.ffmpegBin, ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-t', String(config.voiceMaxS),
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 60_000);
      const out = await exec(config.whisperBin, ['-m', config.whisperModel, '-f', wav, '-l', config.whisperLang,
        '-t', String(config.mediaThreads), '-nt', '-np'], 180_000);
      return out.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(); // drop [BLANK_AUDIO], [music] …
    } finally {
      cleanup(input, wav);
    }
  }

  async function describe(buffer, kind) {
    const input = tmp(kind === 'gif' ? 'mp4' : kind === 'sticker' ? 'webp' : 'jpg');
    const frame = tmp('jpg');
    fs.writeFileSync(input, buffer);
    try {
      const grab = (seek) => exec(config.ffmpegBin, ['-nostdin', '-loglevel', 'error', '-y', ...(seek ? ['-ss', seek] : []),
        '-i', input, '-frames:v', '1', '-vf', 'scale=384:-2', frame], 30_000);
      // middle-ish frame of a GIF says more than the first one; fall back if the clip is too short
      await grab(kind === 'gif' ? '0.8' : null).catch(() => grab(null));
      if (!fs.existsSync(frame) || !fs.statSync(frame).size) throw new Error('no frame');
      const image = fs.readFileSync(frame).toString('base64');
      const res = await fetch(`${config.visionUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          max_tokens: 60,
          temperature: 0.2,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `Describe this ${kind === 'gif' ? 'GIF' : kind} in one short sentence: who or what is in it, what is happening, and the mood or emotion it shows.` },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
            ],
          }],
        }),
      });
      if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
      const json = await res.json();
      return String(json.choices?.[0]?.message?.content || '').replace(/\s+/g, ' ').trim();
    } finally {
      cleanup(input, frame);
    }
  }

  return {
    /**
     * @returns {Promise<{text: string, transcript?: string}>} text for the router; empty text = couldn't understand.
     */
    async toText(media) {
      const buffer = await media.download();
      if (media.kind === 'voice') {
        const transcript = await transcribe(buffer);
        return { text: transcript, transcript };
      }
      let desc = '';
      try {
        desc = await describe(buffer, media.kind);
      } catch (err) {
        log.warn(`vision failed for ${media.kind}: ${err.message}${err.stderr ? ' ' + err.stderr : ''}`);
      }
      const label = LABEL[media.kind] || 'media';
      return { text: desc ? `[sent ${label} showing: ${desc}]` : `[sent ${label}]` };
    },
  };
}
