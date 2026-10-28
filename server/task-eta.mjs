/** Estimate remaining work from measured execution time, never task age. */
export const MAX_TASK_SAMPLE_MS = 30 * 60 * 1000;
export const MAX_ETA_MINUTES = 24 * 60;
const DEFAULT_TASK_MS = 2 * 60 * 1000;

export function estimateTaskEta(openCount, durations = [], concurrency = 3) {
  const open = Math.max(0, Math.floor(Number(openCount) || 0));
  if (!open) return { etaMin: 0, etaCapped: false, sampleCount: 0 };

  const samples = durations.map(Number).filter(ms => Number.isFinite(ms) && ms > 0 && ms <= MAX_TASK_SAMPLE_MS).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length
    ? (samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2)
    : DEFAULT_TASK_MS;
  const parallel = Math.max(1, Math.min(3, Math.floor(Number(concurrency) || 3)));
  const rawMinutes = Math.max(1, Math.ceil((median * open) / parallel / 60_000));
  return {
    etaMin: Math.min(MAX_ETA_MINUTES, rawMinutes),
    etaCapped: rawMinutes > MAX_ETA_MINUTES,
    sampleCount: samples.length
  };
}
