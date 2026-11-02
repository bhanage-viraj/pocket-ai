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

/** Quoted message + the user's words, as one prompt. */
export function quoteBlock(quoted, text) {
  const q = quoted.length > 500 ? quoted.slice(0, 499) + '…' : quoted;
  return text ? `(replying to: "${q}")\n${text}` : `Reply to this message: "${q}"`;
}

export function parseCommand(text) {
  const m = /^\/([a-z][\w-]*)\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const argText = m[2].trim();
  return { name: m[1].toLowerCase(), argText, args: argText ? argText.split(/\s+/) : [] };
}

/**
 * Pure routing decision. Late messages (delivered after a reconnect) are answered too when they
 * were addressed to the bot, up to config.lateReplyMaxS old; plain group chatter stays context only
 * (that already falls out of the normal rules, since unaddressed group messages are ignored).
 */
export function decide(msg, { config, commands }) {
  const d = decideNow(msg, { config, commands });
  if (!msg.stale || d.action === 'ignore') return d;
  const age = Date.now() / 1000 - (msg.timestamp || 0);
  if (age > config.lateReplyMaxS) return { action: 'ignore', reason: 'too-old' };
  return { ...d, late: true };
}

function decideNow(msg, { config, commands }) {
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
    // "@Pocket" as a reply to someone's message = answer that message
    if (!text && msg.quoted) return { action: 'ai', text: quoteBlock(msg.quoted.text, ''), isOwner };
    if (!text) return { action: 'command', name: 'help', args: [], argText: '', isOwner };
    if (msg.quoted && !parseCommand(text)) return { action: 'ai', text: quoteBlock(msg.quoted.text, text), isOwner };
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
  const { config, commands, tasks, detector, chat, memory, context, queue, limiter, metrics, io, db, llm } = deps;
  const taskByName = new Map(tasks.map((t) => [t.name, t]));

  async function handle(msg) {
    try {
      context?.observe(msg); // every message, also ignored ones: group context + who's who
    } catch (err) {
      log.warn('context observe failed:', err.message);
    }
    const d = decide(msg, { config, commands });
    if (d.action === 'ignore') {
      const n = msg.sender.number;
      log.debug(`ignored (${d.reason}) from ${msg.sender.jid?.split('@')[1] ?? '?'} number=${n ? '…' + n.slice(-2) : 'unresolved'}`);
      return d;
    }
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
        await handleAi(ctx, d.text, d.late);
      }
    } catch (err) {
      log.error('handler failed:', err.stack || err.message);
      await reply('⚠️ Something went wrong on my side. Try again?').catch(() => {});
    }
    return d;
  }

  async function handleAi(ctx, text, late = false) {
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
          const extra = context?.build({
            chatId, isGroup, sender, msgId: ctx.msg.id, since: memory.lastReplyTs(chatId),
          }) ?? '';
          const answer = (await chat.reply({ chatId, isGroup, userContent, context: extra })) || '🤔';
          memory.addExchange(chatId, sender.number, userContent, answer);
          return late ? `_(sorry for the late reply, I was offline)_\n${answer}` : answer;
        } finally {
          await io.setTyping(chatId, false);
        }
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        if (late) return log.warn('queue full, dropping a late message'); // don't spam "busy" for backlog
        return reply('🥵 I\'m busy right now, try again in a minute.');
      }
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
