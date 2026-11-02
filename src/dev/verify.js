// Try the fact checker without WhatsApp (needs llama-server running):
//   node src/dev/verify.js "RBI has withdrawn the 2000 rupee note"
import { config } from '../config.js';
import { createLlmClient } from '../llm/client.js';
import { createVerifier, formatVerdict } from '../verify/index.js';

const claim = process.argv.slice(2).join(' ');
if (!claim) { console.log('usage: node src/dev/verify.js "<claim>"'); process.exit(1); }
const t0 = performance.now();
const r = await createVerifier({ llm: createLlmClient({ url: config.llmUrl, timeoutMs: config.llmTimeoutMs }) }).verify(claim);
console.log(formatVerdict(claim, r));
console.log(`\n(${Math.round(performance.now() - t0)} ms, query: "${r.query}")`);
