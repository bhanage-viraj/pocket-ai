export default {
  name: 'help',
  description: 'What I can do',
  async run(ctx) {
    const { config, commands, tasks, isGroup, sender } = ctx;
    const cmds = [...commands.values()]
      .filter((c) => !c.ownerOnly || sender.isOwner)
      .map((c) => `/${c.name} — ${c.description}${c.ownerOnly ? ' 🔒' : ''}`);
    const skills = tasks.filter((t) => t.name !== 'chat').map((t) => `• ${t.description.split('(')[0].trim()}`);
    if (ctx.web) skills.push('• Live info: _weather in Denpasar_, _100 usd to inr_, _latest news on X_, or /search <anything>');
    const how = isGroup
      ? `Tag me (@${config.botName}), reply to my message, or start with "${config.groupTriggers.join('" / "')}".`
      : 'Just message me — English or Hinglish.';
    await ctx.reply(
      [`*${config.botName}* 🤖 — AI running on a phone`, how, '', '*I understand:*', ...skills, '', '*Commands:*', ...cmds].join('\n'),
    );
  },
};
