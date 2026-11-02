export default {
  name: 'reset',
  description: 'Forget this chat\'s conversation',
  async run(ctx) {
    ctx.memory.clear(ctx.chatId);
    await ctx.reply('🧹 Memory cleared for this chat.');
  },
};
