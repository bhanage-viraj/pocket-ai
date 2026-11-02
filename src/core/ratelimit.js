// Sliding-window rate limiter, keyed by sender. Pure code, no AI.
export function createRateLimiter({ perMinute = 6, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    /** true if allowed (and records the hit). */
    take(key) {
      if (perMinute <= 0) return true;
      const t = now();
      const recent = (hits.get(key) || []).filter((x) => t - x < 60_000);
      if (recent.length >= perMinute) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}
