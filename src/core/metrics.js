// Records every model call (tokens, speed, cache hits, latency) to SQLite for /stats and the README.
import { mean, percentile, round } from '../util/stats.js';

export function createMetrics(db) {
  const insert = db.prepare(`INSERT INTO generations
    (ts, kind, model, prompt_n, cache_n, predicted_n, prompt_ms, predicted_ms, wall_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const started = Date.now();
  let handled = 0;

  return {
    record(kind, model, { timings: t, wallMs }) {
      insert.run(Date.now(), kind, model, t.promptN, t.cacheN, t.predictedN, t.promptMs, t.predictedMs, wallMs);
    },
    countMessage() {
      handled++;
    },
    /** Summary of the last `limit` generations per kind. */
    summary(limit = 100) {
      const kinds = {};
      for (const kind of ['intent', 'chat']) {
        const rows = db
          .prepare('SELECT * FROM generations WHERE kind = ? ORDER BY id DESC LIMIT ?')
          .all(kind, limit);
        if (!rows.length) continue;
        const tps = rows.filter((r) => r.predicted_ms > 0).map((r) => (r.predicted_n / r.predicted_ms) * 1000);
        const pps = rows.filter((r) => r.prompt_ms > 0 && r.prompt_n > 0).map((r) => (r.prompt_n / r.prompt_ms) * 1000);
        const lat = rows.map((r) => r.wall_ms);
        const promptTotal = rows.reduce((a, r) => a + r.prompt_n + r.cache_n, 0);
        const cached = rows.reduce((a, r) => a + r.cache_n, 0);
        kinds[kind] = {
          n: rows.length,
          genTokPerSec: round(mean(tps)),
          promptTokPerSec: round(mean(pps)),
          avgMs: Math.round(mean(lat)),
          p95Ms: Math.round(percentile(lat, 95)),
          cacheHitPct: promptTotal ? Math.round((cached / promptTotal) * 100) : 0,
        };
      }
      return { kinds, uptimeS: (Date.now() - started) / 1000, handled };
    },
  };
}
