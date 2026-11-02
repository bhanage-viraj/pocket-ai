export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

export const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
