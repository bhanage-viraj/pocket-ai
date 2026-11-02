// The central router. Every incoming message goes through decide() (pure, no AI):
//
//   ignore   – not for us (group chatter, DM from a non-allowed number, empty)
//   command  – "/something" -> a command handler (plain code)
//   deny     – owner-only command from someone else
//   ai       – needs the model: intent detection -> task handler, or chat reply
//
// handle() then executes the decision: rate limit -> queue -> intent -> task/chat -> reply.
import { isAllowedDm, isOwnerNumber } from '../config.js';
import { checkGroupTrigger } from './triggers.js';
import { QueueFullError } from './queue.js';
import { log } from '../util/log.js';

export function parseCommand(text) {
  const m = /^\/([a-z][\w-]*)\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const argText = m[2].trim();
  return { name: m[1].toLowerCase(), argText, args: argText ? argText.split(/\s+/) : [] };
}

/** Pure routing decision. */
export function decide(msg, { config, commands }) {
  const isOwner = isOwnerNumber(msg.sender.number);
  let text = (msg.text || '').trim();
  // a bare "@Pocket" in a group arrives empty (mention stripped) but should still get /help
  if (!text && !(msg.isGroup && msg.mentionsBot)) return { action: 'ignore', reason: 'empty' };

  if (msg.isGroup) {
    const t = checkGroupTrigger({
      text,
      mentionsBot: msg.mentionsBot,
      repliesToBot: msg.repliesToBot,
      triggers: config.groupTriggers,
    });
    if (!t.triggered) return { action: 'ignore', reason: t.reason };
    text = t.text;
    if (!text) return { action: 'command', name: 'help', args: [], argText: '', isOwner };
  } else {
    if (!isAllowedDm(msg.sender.number)) return { action: 'ignore', reason: 'dm-not-allowed' };
    // "/ai question" also works in DMs
    const ai = /^\/ai\b\s*/i.exec(text);
    if (ai) text = text.slice(ai[0].length).trim() || 'hi';
  }

  const cmd = parseCommand(text);
  if (cmd) {
    const command = commands.get(cmd.name);
    if (!command) return { action: 'command', ...cmd, name: 'unknown', typed: cmd.name, isOwner };
    if (command.ownerOnly && !isOwner) return { action: 'deny', name: cmd.name, isOwner };
    return { action: 'command', ...cmd, isOwner };
  }
  return { action: 'ai', text, isOwner };
}

export function createRouter(deps) {
  const { config, commands, tasks, detector, chat, memory, queue, limiter, metrics, io, db, llm } = deps;
  const taskByName = new Map(tasks.map((t) => [t.name, t]));

  async function handle(msg) {
    const d = decide(msg, { config, commands });
    if (d.action === 'ignore') return d;
    metrics.countMessage();

    const sender = { ...msg.sender, isOwner: d.isOwner };
    const reply = (text) => io.reply(msg, text);
    const ctx = { ...deps, msg, chatId: msg.chatId, isGroup: msg.isGroup, sender, reply };
    log.info(`→ ${msg.isGroup ? 'group' : 'dm'} ${sender.name} [${d.action}${d.name ? ' /' + d.name : ''}] ${(d.text ?? msg.text).slice(0, 60)}`);

    try {
      if (d.action === 'deny') {
        await reply('⛔ That command is owner-only.');
      } else if (d.action === 'command') {
        if (d.name === 'unknown') await reply(`Unknown command /${d.typed}. Send /help to see what I can do.`);
        else await commands.get(d.name).run({ ...ctx, args: d.args, argText: d.argText });
      } else {
        await handleAi(ctx, d.text);
      }
    } catch (err) {
      log.error('handler failed:', err.stack || err.message);
      await reply('⚠️ Something went wrong on my side. Try again?').catch(() => {});
    }
    return d;
  }

  async function handleAi(ctx, text) {
    const { sender, chatId, isGroup, reply } = ctx;
    if (!sender.isOwner && !limiter.take(sender.jid)) {
      if (!isGroup) await reply('⏳ Too many messages — give me a minute.');
      return;
    }

    let job;
    try {
      job = queue.push(async () => {
        await io.setTyping(chatId, true);
        try {
          const intent = await detector.detect(text);
          log.info(`  intent=${intent.intent} via=${intent.via} ${Math.round(intent.ms)}ms`, JSON.stringify(intent.fields));
          const task = taskByName.get(intent.intent);
          const userContent = isGroup ? `[${sender.name}]: ${text}` : text;

          if (task?.handle && (task.permission !== 'owner' || sender.isOwner)) {
            const answer = await task.handle({ ...ctx, text }, intent.fields);
            memory.addExchange(chatId, sender.number, userContent, answer);
            return answer;
          }
          const answer = (await chat.reply({ chatId, isGroup, userContent })) || '🤔';
          memory.addExchange(chatId, sender.number, userContent, answer);
          return answer;
        } finally {
          await io.setTyping(chatId, false);
        }
      });
    } catch (err) {
      if (err instanceof QueueFullError) return reply('🥵 I\'m busy right now, try again in a minute.');
      throw err;
    }
    if (job.position > 0) await reply(`⏳ In queue (#${job.position})…`);

    try {
      await reply(await job.done);
    } catch (err) {
      log.error('generation failed:', err.message);
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      const down = /fetch failed|ECONNREFUSED/.test(err.message + (err.cause?.code || ''));
      await reply(
        timeout ? '⌛ That took too long, try a shorter question.'
        : down ? '😴 My brain (llama-server) is offline. It should restart by itself shortly.'
        : '⚠️ Sorry, something went wrong. Try again?',
      );
    }
  }

  return { handle, decide: (msg) => decide(msg, { config, commands }) };
}
