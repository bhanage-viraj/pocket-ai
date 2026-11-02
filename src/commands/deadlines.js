// /deadlines — your upcoming deadlines (from portal screenshots). /deadlines done <id>
export default {
  name: 'deadlines',
  description: 'Your deadlines (send a portal screenshot with caption "deadlines" to add)',
  async run(ctx) {
    const { deadlines, chatId, args } = ctx;
    if (!deadlines) return ctx.reply('Deadlines are off.');
    if (/^(done|did|submitted|x)$/i.test(args[0] || '')) {
      const ids = args.slice(1).map(Number).filter(Boolean);
      const n = ids.reduce((s, id) => s + deadlines.markDone(chatId, id), 0);
      return ctx.reply(n ? `✅ Marked ${n} done. Nice!` : 'No matching open deadline. See /deadlines for ids.');
    }
    await ctx.reply(deadlines.listText(chatId));
  },
};
