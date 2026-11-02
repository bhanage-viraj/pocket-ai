export default {
  name: 'me',
  description: 'What I know about you',
  async run(ctx) {
    const { sender, chatId, isGroup } = ctx;
    const p = ctx.context?.person(sender.number);
    const facts = ctx.context?.facts(sender.number, { chatId, isGroup }) ?? [];
    const since = p ? new Date(p.first_seen).toISOString().slice(0, 10) : null;
    const lines = [
      `👤 *${p?.name || sender.name}*`,
      p ? `Talking since ${since} · ${p.messages} messages` : 'First time we talk!',
      facts.length
        ? `\nYou asked me to remember${isGroup ? ' (in this group)' : ''}:\n${facts.map((f) => `• ${f}`).join('\n')}`
        : '\nNothing saved yet. Say _"remember that …"_ and I\'ll keep it.',
    ];
    await ctx.reply(lines.join('\n'));
  },
};
