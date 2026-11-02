// /verify <claim>, or reply to any message with "@Pocket verify this" / "fact check" / "sach hai kya".
// Free and on-device: Wikipedia + Google News RSS as evidence, Gemma as the judge (src/verify).
import { createVerifier, formatVerdict } from '../verify/index.js';

let verifier = null;

export default {
  name: 'verify',
  description: 'Fact-check a claim with web sources: reply to a message with "verify this"',
  groupDirect: true,
  async run(ctx) {
    const { msg, argText, llm, queue, sender, limiter } = ctx;
    const claim = (msg?.quoted?.text || argText.replace(/^(this|that|ye|yeh)\b[:\s-]*/i, '')).trim();
    if (claim.length < 8) {
      return ctx.reply('🔎 Reply to a message with *@Pocket verify this*, or send _/verify <claim>_.');
    }
    if (!sender.isOwner && limiter && !limiter.take(`verify:${sender.jid}`)) return;
    verifier ??= createVerifier({ llm });
    await ctx.reply('🔎 Checking the web…');
    const job = queue.push(() => verifier.verify(claim));
    try {
      await ctx.reply(formatVerdict(claim, await job.done));
    } catch (err) {
      await ctx.reply(`⚠️ Couldn't finish the fact check (${err.message}). Try again in a bit.`);
    }
  },
};
