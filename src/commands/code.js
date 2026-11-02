// /code [project:] <task> — owner only. Claude Code works on a new branch on the Mac and reports back.
export default {
  name: 'code',
  description: 'Claude Code on my Mac: /code [project:] <task>',
  ownerOnly: true,
  groupDirect: true,
  async run(ctx) {
    const { bridge, chatId, sender, argText } = ctx;
    if (!bridge?.enabled) return ctx.reply('Claude isn\'t set up yet (MAC_BRIDGE_URL / BRIDGE_TOKEN in .env).');
    if (!argText) return ctx.reply('Usage: /code [project:] <task>\ne.g. /code pocket-ai: add a /time command');
    const m = /^([\w.-]+):\s+([\s\S]+)$/.exec(argText);
    const [project, prompt] = m ? [m[1].toLowerCase(), m[2]] : [null, argText];
    await ctx.reply(await bridge.enqueue({ chatId, sender, mode: 'code', prompt, project }));
  },
};
