// /claude <question> — ask Claude (on the Mac, via the bridge). No tools: it can't touch the Mac.
// Works for owners anywhere and for anyone in a group (also without tagging the bot).
export default {
  name: 'claude',
  description: 'Ask Claude (smart, via my Mac): /claude <question>',
  groupDirect: true,
  async run(ctx) {
    const { bridge, config, sender, chatId, argText } = ctx;
    if (!bridge?.enabled) return ctx.reply('Claude isn\'t set up yet (MAC_BRIDGE_URL / BRIDGE_TOKEN in .env).');
    if (!argText) return ctx.reply('Usage: /claude <your question>');
    if (!sender.isOwner && bridge.usedLastHour(sender.number) >= config.claudePerHour) {
      return ctx.reply(`⏳ You've used /claude ${config.claudePerHour} times this hour. Try again later.`);
    }
    await ctx.reply(await bridge.enqueue({ chatId, sender, mode: 'ask', prompt: argText }));
  },
};
