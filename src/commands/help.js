export default {
  name: 'help',
  description: 'What I can do',
  async run(ctx) {
    const { config, commands, tasks, isGroup, sender } = ctx;
    const cmds = [...commands.values()]
      .filter((c) => !c.ownerOnly || sender.isOwner)
      .map((c) => `/${c.name} — ${c.description}${c.ownerOnly ? ' 🔒' : ''}`);
    const skills = tasks.filter((t) => t.name !== 'chat').map((t) => `• ${t.description.split('(')[0].trim()}`);
    const how = isGroup
      ? `Tag me (@${config.botName}), reply to my message, or start with "${config.groupTriggers.join('" / "')}".`
      : 'Just message me — English or Hinglish.';
    await ctx.reply(
      [`*${config.botName}* 🤖 — offline AI on a phone`, how, '', '*I understand:*', ...skills, '', '*Commands:*', ...cmds].join('\n'),
    );
  },
};
