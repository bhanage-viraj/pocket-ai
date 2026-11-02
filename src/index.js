// Pocket AI — entry point. Wires the gateway, router, model client and storage together.
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { createLlmClient } from './llm/client.js';
import { loadTasks } from './tasks/index.js';
import { loadCommands } from './commands/index.js';
import { createIntentDetector } from './intent/detect.js';
import { createChat } from './core/chat.js';
import { createMemory } from './core/memory.js';
import { createContext } from './core/context.js';
import { createQueue } from './core/queue.js';
import { createRateLimiter } from './core/ratelimit.js';
import { createMetrics } from './core/metrics.js';
import { createRouter } from './core/router.js';
import { createWhatsAppGateway } from './gateway/whatsapp.js';
import { log } from './util/log.js';

async function main() {
  if (!config.ownerNumbers.length) {
    log.error('OWNER_NUMBERS is empty. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const db = openDb(path.join(config.dataDir, 'pocket.db'));
  const tasks = await loadTasks();
  for (const t of tasks) t.migrate?.(db);
  const commands = await loadCommands(tasks);

  const llm = createLlmClient({ url: config.llmUrl, timeoutMs: config.llmTimeoutMs });
  const metrics = createMetrics(db);
  let modelName = 'unknown';
  const onGeneration = (kind, result) => metrics.record(kind, modelName, result);

  const memory = createMemory(db, { turns: config.historyTurns });
  const context = createContext(db, { groupLines: config.groupContextLines });
  const detector = createIntentDetector({ llm, tasks, prefilter: config.intentPrefilter, onGeneration });
  const chat = createChat({ llm, memory, config, onGeneration });

  const gateway = createWhatsAppGateway({ config, onMessage: (msg) => router.handle(msg) });
  const router = createRouter({
    config, db, llm, tasks, commands, detector, chat, memory, context, metrics,
    queue: createQueue({ max: config.queueMax }),
    limiter: createRateLimiter({ perMinute: config.rateLimitPerMin }),
    io: gateway.io,
  });

  if (await llm.health()) {
    modelName = await llm.model();
    log.info(`🧠 llama-server OK at ${config.llmUrl} — model ${modelName}`);
  } else {
    log.warn(`🧠 llama-server not reachable at ${config.llmUrl} — replies will fail until it is up.`);
    const retry = setInterval(async () => {
      if (await llm.health()) {
        modelName = await llm.model();
        log.info(`🧠 llama-server is up — model ${modelName}`);
        clearInterval(retry);
      }
    }, 10_000);
  }
  log.info(`Tasks: ${tasks.map((t) => t.name).join(', ')} · Commands: ${[...commands.keys()].map((c) => '/' + c).join(' ')}`);

  await gateway.connect();

  const shutdown = (sig) => {
    log.info(`${sig} received, shutting down`);
    try {
      db.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err?.stack || err));

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
