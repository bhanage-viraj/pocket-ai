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
import { MediaUnavailableError } from '../media/index.js';
import { STICKER_RE } from '../stickers/index.js';
import { log } from '../util/log.js';

const STICKABLE = new Set(['image', 'gif', 'sticker']);
/**
 * "Make a sticker" request? A photo/GIF/sticker with "sticker …" in the caption, or a reply to one.
 * DMs: "sticker" anywhere. Groups: caption starts with "sticker" / "/sticker", or the bot is tagged.
 * @returns {{media: object, prompt: string}|null}
 */
export function stickerRequest(msg) {
  const text = (msg.text || '').trim();
  if (!STICKER_RE.test(text)) return null;
  const media = STICKABLE.has(msg.media?.kind) ? msg.media : STICKABLE.has(msg.quoted?.media?.kind) ? msg.quoted.media : null;
  if (!media) return null;
  // Groups: tagged, or starts with "sticker", or a reply to the photo that clearly asks to make one
  // ("isko sticker bana do", "make a sticker of this") — but not "nice sticker lol".
  const asks = /\b(make|create|convert|turn|bana|banao|banado|bana do|banade|chahiye|de do|dedo)\b/i.test(text);
  if (msg.isGroup && !msg.mentionsBot && !/^\/?(sticker|stiker)\b/i.test(text) && !(media === msg.quoted?.media && asks)) return null;
  return { media, prompt: text.replace(/^\/(sticker|stiker)\b\s*/i, '') || 'sticker' };
}

const VERIFY_RE = /^(verify|fact[- ]?check|check (this|that|if)|is (this|that|it) (true|real|fake)|sach hai( kya)?|ye sach hai( kya)?|fake hai( kya)?)\b[?!.:,\s]*/i;
/** "verify this" / "fact check: …" -> the /verify command (claim = quoted message or the rest). */
function verifyDecision(text, isOwner) {
  const m = VERIFY_RE.exec(text);
  if (!m) return null;
  const argText = text.slice(m[0].length).trim();
  return { action: 'command', name: 'verify', args: argText ? argText.split(/\s+/) : [], argText, isOwner };
}

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
    // a few commands (/claude, /code) work in groups without tagging the bot
    const direct = parseCommand(text);
    if (direct && commands.get(direct.name)?.groupDirect) {
      const command = commands.get(direct.name);
      if (command.ownerOnly && !isOwner) return { action: 'deny', name: direct.name, isOwner };
      return { action: 'command', ...direct, isOwner };
    }
    const t = checkGroupTrigger({
      text,
      mentionsBot: msg.mentionsBot,
      repliesToBot: msg.repliesToBot,
      triggers: config.groupTriggers,
    });
    if (!t.triggered) return { action: 'ignore', reason: t.reason };
    text = t.text;
    if (/^(tl;?dr|summary|summarize|summarise|what did i miss|kya miss kiya)\b[?!. ]*$/i.test(text)) {
      return { action: 'command', name: 'summary', args: [], argText: '', isOwner };
    }
    const v = verifyDecision(text, isOwner);
    if (v && commands.has('verify')) return v;
    // "@Pocket" as a reply to someone's message = answer that message
    if (!text && msg.quoted?.text) return { action: 'ai', text: quoteBlock(msg.quoted.text, ''), isOwner };
    if (!text) return { action: 'command', name: 'help', args: [], argText: '', isOwner };
    if (msg.quoted?.text && !parseCommand(text)) return { action: 'ai', text: quoteBlock(msg.quoted.text, text), isOwner };
  } else {
    if (!isAllowedDm(msg.sender.number)) return { action: 'ignore', reason: 'dm-not-allowed' };
    const v = verifyDecision(text, isOwner);
    if (v && commands.has('verify')) return v;
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
  const { config, commands, tasks, detector, chat, memory, context, media, stickers, queue, limiter, metrics, io, db, llm } = deps;
  const taskByName = new Map(tasks.map((t) => [t.name, t]));

  async function handle(msg) {
    try {
      context?.observe(msg); // every message, also ignored ones: group context + who's who
    } catch (err) {
      log.warn('context observe failed:', err.message);
    }
    const st = stickers && stickerRequest(msg);
    if (st && (msg.isGroup || isAllowedDm(msg.sender.number)) && !msg.stale) return handleSticker(msg, st);
    if (msg.media && !msg.text) return handleMedia(msg);
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

  async function handleSticker(msg, { media: m, prompt }) {
    const isOwner = isOwnerNumber(msg.sender.number);
    const reply = (t) => io.reply(msg, t);
    log.info(`→ ${msg.isGroup ? 'group' : 'dm'} ${msg.sender.name} [sticker from ${m.kind}] ${prompt.slice(0, 60)}`);
    if (!isOwner && !limiter.take(msg.sender.jid)) return { action: 'ignore', reason: 'rate' };
    metrics.countMessage();
    try {
      const job = queue.push(async () => {
        const t0 = performance.now();
        const { webp, spec } = await stickers.make(await m.download(), m.kind, prompt);
        log.info(`  sticker ${JSON.stringify(spec)} ${Math.round(webp.length / 1024)}KB ${Math.round(performance.now() - t0)}ms`);
        return webp;
      });
      await io.sendSticker(msg, await job.done);
    } catch (err) {
      if (err instanceof QueueFullError) await reply('🥵 I\'m busy right now, try again in a minute.');
      else if (err instanceof MediaUnavailableError) await reply('🎨 Sticker maker is still being set up on my phone. Try again in a bit.');
      else {
        log.error('sticker failed:', err.message);
        await reply('⚠️ Couldn\'t make that sticker. Try a different photo or a simpler prompt.');
      }
    }
    return { action: 'sticker' };
  }

  /** Voice note / GIF / sticker / photo with no caption. Only processed when it's meant for the bot. */
  async function handleMedia(msg) {
    const addressed = msg.isGroup ? msg.mentionsBot || msg.repliesToBot : isAllowedDm(msg.sender.number);
    const age = Date.now() / 1000 - (msg.timestamp || 0);
    if (!addressed || !media || (msg.stale && age > config.lateReplyMaxS)) {
      log.debug(`ignored ${msg.media.kind} (${!media ? 'media off' : !addressed ? 'not addressed' : 'too old'})`);
      return { action: 'ignore', reason: 'media' };
    }
    if (msg.media.kind === 'voice' && msg.media.seconds > config.voiceMaxS * 2) {
      await io.reply(msg, `🎤 That voice note is too long for me (max ~${config.voiceMaxS}s).`);
      return { action: 'ignore', reason: 'too-long' };
    }
    metrics.countMessage();
    const sender = { ...msg.sender, isOwner: isOwnerNumber(msg.sender.number) };
    const ctx = { ...deps, msg, chatId: msg.chatId, isGroup: msg.isGroup, sender, reply: (t) => io.reply(msg, t) };
    log.info(`→ ${msg.isGroup ? 'group' : 'dm'} ${sender.name} [${msg.media.kind}${msg.media.seconds ? ' ' + msg.media.seconds + 's' : ''}]`);
    try {
      await handleAi(ctx, '', !!msg.stale, msg.media);
    } catch (err) {
      log.error('media handler failed:', err.stack || err.message);
      await ctx.reply('⚠️ Something went wrong on my side. Try again?').catch(() => {});
    }
    return { action: 'ai', media: msg.media.kind };
  }

  async function handleAi(ctx, text, late = false, mediaIn = null) {
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
          let heard = '';
          if (mediaIn) {
            const t0 = performance.now();
            const r = await media.toText(mediaIn);
            log.info(`  ${mediaIn.kind} -> "${r.text.slice(0, 80)}" ${Math.round(performance.now() - t0)}ms`);
            if (!r.text) return mediaIn.kind === 'voice' ? '🎤 Sorry, I couldn\'t make out that voice note.' : '🤔';
            text = r.text;
            heard = r.transcript ? `🎤 _"${r.transcript.length > 300 ? r.transcript.slice(0, 299) + '…' : r.transcript}"_\n\n` : '';
          }
          const intent = await detector.detect(text);
          log.info(`  intent=${intent.intent} via=${intent.via} ${Math.round(intent.ms)}ms`, JSON.stringify(intent.fields));
          const task = taskByName.get(intent.intent);
          const userContent = isGroup ? `[${sender.name}]: ${text}` : text;

          if (task?.handle && (task.permission !== 'owner' || sender.isOwner)) {
            const answer = await task.handle({ ...ctx, text }, intent.fields);
            // a task may answer with its own message (e.g. a poll) and return null: nothing more to say
            memory.addExchange(chatId, sender.number, userContent, answer ?? `[did ${task.name}]`);
            return answer == null ? (heard || null) : heard + answer;
          }
          const extra = context?.build({
            chatId, isGroup, sender, msgId: ctx.msg.id, since: memory.lastReplyTs(chatId),
          }) ?? '';
          const answer = (await chat.reply({ chatId, isGroup, userContent, context: extra })) || '🤔';
          memory.addExchange(chatId, sender.number, userContent, answer);
          return (late ? '_(sorry for the late reply, I was offline)_\n' : '') + heard + answer;
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
      const answer = await job.done;
      if (answer) await reply(answer);
    } catch (err) {
      log.error('generation failed:', err.message);
      if (err instanceof MediaUnavailableError) {
        return reply('🎤 I can\'t listen to voice notes yet: my speech model is still being set up on the phone. Try again in a bit, or type it.');
      }
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
