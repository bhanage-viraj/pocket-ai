export default {
  name: 'sticker',
  description: 'Make a sticker: send a photo/GIF with caption "sticker <prompt>"',
  async run(ctx) {
    await ctx.reply(
      '🎨 *Sticker maker*\nSend a photo or GIF with a caption, or reply to one:\n' +
        '• _sticker_\n• _sticker with text "Monday mood"_\n• _round sticker, upar likho chai time in yellow_\n' +
        'GIFs become animated stickers. In groups start the caption with "sticker".',
    );
  },
};
