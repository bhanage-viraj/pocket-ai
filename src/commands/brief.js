// /brief — morning brief now. /brief off | on | 07:30 (owner only: it's your personal summary)
export default {
  name: 'brief',
  description: 'Your morning brief (/brief off | on | 07:30)',
  ownerOnly: true,
  async run(ctx) {
    const { brief, settings, args, config } = ctx;
    const a = (args[0] || '').toLowerCase();
    if (a === 'off' || a === 'on') {
      settings.set('brief', a);
      return ctx.reply(a === 'on' ? `☀️ Morning brief on (${settings.get('brief_time', config.briefTime)}).` : '🌙 Morning brief off.');
    }
    if (/^\d{1,2}:\d{2}$/.test(a)) {
      const t = a.padStart(5, '0');
      settings.set('brief_time', t);
      return ctx.reply(`☀️ Morning brief at ${t} (${config.timezone}).`);
    }
    await ctx.reply(brief.text());
  },
};
