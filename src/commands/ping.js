export default {
  name: 'ping',
  description: 'Am I alive?',
  async run(ctx) {
    const t0 = performance.now();
    const ok = await ctx.llm.health();
    const ms = Math.round(performance.now() - t0);
    await ctx.reply(`🏓 pong — model server ${ok ? `✅ (${ms} ms)` : '❌ offline'}`);
  },
};
