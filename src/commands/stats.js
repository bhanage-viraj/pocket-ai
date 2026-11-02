import { batteryStatus, memInfo, processRssMb } from '../util/system.js';

const dur = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m`;
};

export default {
  name: 'stats',
  description: 'Speed, latency, RAM, battery',
  async run(ctx) {
    const [model, battery] = await Promise.all([ctx.llm.model(), batteryStatus()]);
    const { kinds, uptimeS, handled } = ctx.metrics.summary(100);
    const mem = memInfo();
    const line = (label, k) =>
      k
        ? `*${label}* (last ${k.n}): ${k.genTokPerSec} tok/s gen · ${k.promptTokPerSec} tok/s prompt\n` +
          `   avg ${k.avgMs} ms · p95 ${k.p95Ms} ms · cache ${k.cacheHitPct}%`
        : `*${label}*: no data yet`;
    await ctx.reply(
      [
        '📊 *Pocket AI stats*',
        `Model: ${model}`,
        line('Chat', kinds.chat),
        line('Intent', kinds.intent),
        `Queue: ${ctx.queue.size} · Messages: ${handled} · Uptime: ${dur(uptimeS)}`,
        `RAM: ${Math.round(mem.availableMb)} MB free / ${Math.round(mem.totalMb)} MB · bot ${Math.round(processRssMb())} MB`,
        battery
          ? `Battery: ${battery.percent}% · ${battery.tempC?.toFixed?.(1) ?? battery.tempC}°C · ${battery.status}`
          : 'Battery: n/a (needs Termux:API)',
      ].join('\n'),
    );
  },
};
