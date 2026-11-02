// /summary (also "@Pocket tldr") — group TL;DR of what you missed, made on the phone.
import { SLOTS } from '../llm/client.js';
import { toWhatsApp } from '../util/text.js';

const PROMPT =
  'You summarize a WhatsApp group chat for someone who missed it. Write 3-6 short bullet points (•): the main topics, ' +
  'decisions, plans, questions still open, and who said what. Use names. Match the chat\'s language (Hinglish stays Hinglish, ' +
  'in Roman letters). No intro line, no markdown headings.';

export default {
  name: 'summary',
  description: 'Group TL;DR of what you missed',
  groupDirect: true,
  async run(ctx) {
    const { context, config, llm, queue, chatId, sender, msg } = ctx;
    if (!ctx.isGroup) return ctx.reply('/summary works in groups: it sums up what you missed there.');
    const { lines, missed } = context.transcript(chatId, { number: sender.number, max: config.summaryMaxLines, excludeId: msg?.id });
    if (lines.length < 3) return ctx.reply('Not much to summarize yet. I only see messages from after I joined/started.');
    const transcript = lines.map((l) => `[${l.name}]: ${l.text}`).join('\n');
    const job = queue.push(async () => {
      const r = await llm.complete({
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: transcript }],
        maxTokens: 260, temperature: 0.3, slot: SLOTS.chat,
      });
      return toWhatsApp(r.text.trim());
    });
    if (job.position > 0) await ctx.reply(`⏳ In queue (#${job.position})…`);
    const head = missed ? `📝 *What you missed* (${lines.length} messages)` : `📝 *Last ${lines.length} messages*`;
    await ctx.reply(`${head}\n${await job.done}`);
  },
};
