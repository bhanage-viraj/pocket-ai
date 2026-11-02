// Try the live-info lookup from the terminal: node src/dev/web.js weather in Kuta Bali
import { createWeb, needsWeb } from '../web/index.js';
import { createVerifier } from '../verify/index.js';
import { config } from '../config.js';

const q = process.argv.slice(2).join(' ') || 'weather in Denpasar';
const kind = needsWeb(q) || 'search';
const t0 = performance.now();
const r = await createWeb({ config, search: createVerifier({}) }).lookup(q, { chatId: 'dev', kind });
console.log(`[${kind}] ${Math.round(performance.now() - t0)}ms\n${r?.direct ?? r?.block ?? 'nothing'}`);
