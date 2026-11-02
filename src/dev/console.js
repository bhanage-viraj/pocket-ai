#!/usr/bin/env node
// Chat with Pocket AI in the terminal — same router, tasks and model, no WhatsApp needed.
//   npm run console                    # DM as the owner
//   npm run console -- --group         # pretend to be in a group (needs "@pocket" / "/ai" / "hey pocket")
//   npm run console -- --as 919800000001 --name Rahul
// In group mode, type "@bot ..." to simulate an @mention and "^ ..." to simulate replying to the bot.
import readline from 'node:readline';
import { parseArgs } from 'node:util';

// Without a .env, act as a local owner so the console works out of the box.
process.env.OWNER_NUMBERS ||= '910000000000';
const { config } = await import('../config.js');
const { openDb } = await import('../db/index.js');
const { createLlmClient } = await import('../llm/client.js');
const { loadTasks } = await import('../tasks/index.js');
const { loadCommands } = await import('../commands/index.js');
const { createIntentDetector } = await import('../intent/detect.js');
const { createChat } = await import('../core/chat.js');
const { createMemory } = await import('../core/memory.js');
const { createContext } = await import('../core/context.js');
const { createQueue } = await import('../core/queue.js');
const { createRateLimiter } = await import('../core/ratelimit.js');
const { createMetrics } = await import('../core/metrics.js');
const { createRouter } = await import('../core/router.js');

const { values: args } = parseArgs({
  options: {
    group: { type: 'boolean', default: false },
    as: { type: 'string' },
    name: { type: 'string', default: 'You' },
    db: { type: 'string', default: ':memory:' },
  },
});

const db = openDb(args.db);
const tasks = await loadTasks();
for (const t of tasks) t.migrate?.(db);
const commands = await loadCommands(tasks);
const llm = createLlmClient({ url: config.llmUrl, timeoutMs: config.llmTimeoutMs });
const metrics = createMetrics(db);
const model = (await llm.health()) ? await llm.model() : 'offline';
const onGeneration = (kind, r) => {
  metrics.record(kind, model, r);
  console.log(`\x1b[2m  [${kind}] ${r.timings.predictedN} tok · ${Math.round(r.wallMs)} ms · ${r.timings.tokPerSec.toFixed(1)} tok/s · cache ${r.timings.cacheN}/${r.timings.cacheN + r.timings.promptN}\x1b[0m`);
};
const memory = createMemory(db, { turns: config.historyTurns });

const router = createRouter({
  config, db, llm, tasks, commands, metrics, memory,
  context: createContext(db, { groupLines: config.groupContextLines }),
  detector: createIntentDetector({ llm, tasks, prefilter: config.intentPrefilter, onGeneration }),
  chat: createChat({ llm, memory, config, onGeneration }),
  queue: createQueue({ max: config.queueMax }),
  limiter: createRateLimiter({ perMinute: config.rateLimitPerMin }),
  io: {
    reply: async (_msg, text) => console.log(`\x1b[36m${config.botName}:\x1b[0m ${text}\n`),
    setTyping: async () => {},
  },
});

const number = args.as || config.ownerNumbers[0] || '0';
console.log(`Pocket AI console · model ${model} · ${args.group ? 'GROUP' : 'DM'} as ${args.name} (${number}) · Ctrl+C to quit\n`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!process.stdin.isTTY) console.log(line);
  if (line) {
    const mention = args.group && /^@bot\b/i.test(line);
    const replyTo = args.group && line.startsWith('^');
    const d = await router.handle({
      id: String(Date.now()),
      chatId: args.group ? 'console@g.us' : `${number}@s.whatsapp.net`,
      isGroup: args.group,
      text: line.replace(/^@bot\b|^\^/i, '').trim(),
      timestamp: Math.floor(Date.now() / 1000),
      sender: { jid: `${number}@s.whatsapp.net`, number, name: args.name },
      mentionsBot: mention,
      repliesToBot: replyTo,
    });
    if (d.action === 'ignore') console.log(`\x1b[2m  (ignored: ${d.reason})\x1b[0m\n`);
  }
  if (process.stdin.isTTY) rl.prompt();
  else process.stdout.write('> ');
}
process.exit(0);
