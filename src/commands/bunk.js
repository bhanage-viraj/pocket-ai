// /bunk <attended> <total> [required %] — how many classes you can skip, or must attend. Pure maths.
export function bunk(attended, total, required = 75) {
  const p = required / 100;
  if (!(total > 0) || attended < 0 || attended > total || !(p > 0 && p < 1)) return null;
  const pct = (attended / total) * 100;
  if (attended / total >= p) {
    const skip = Math.floor(attended / p - total + 1e-9);
    return { pct, skip, need: 0 };
  }
  const need = Math.ceil((p * total - attended) / (1 - p) - 1e-9);
  return { pct, skip: 0, need };
}

export default {
  name: 'bunk',
  description: 'Attendance: /bunk <attended> <total> [required %]',
  async run(ctx) {
    const [a, t, r = 75] = ctx.args.map((x) => Number(String(x).replace('%', '')));
    const res = bunk(a, t, r);
    if (!res) return ctx.reply('📊 Usage: /bunk <attended> <total> [required %]\ne.g. /bunk 42 50 75');
    const now = `📊 ${a}/${t} = *${res.pct.toFixed(1)}%* (need ${r}%)`;
    if (res.skip > 0) return ctx.reply(`${now}\n😎 You can skip *${res.skip}* more class${res.skip === 1 ? '' : 'es'} and stay at ${r}%.`);
    if (res.need > 0) return ctx.reply(`${now}\n📚 Attend the next *${res.need}* class${res.need === 1 ? '' : 'es'} in a row to get back to ${r}%.`);
    return ctx.reply(`${now}\n⚖️ Exactly on the line: don't skip the next one!`);
  },
};
