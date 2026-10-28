/** Deterministic per-provider breaker with a single half-open probe. */
export function createCircuitBreaker({ failureThreshold = 3, resetAfterMs = 30_000, clock = Date.now, shouldTrip = defaultShouldTrip } = {}) {
  const states = new Map();
  const entry = key => states.get(key) || { state: 'CLOSED', failures: 0, openedAt: 0, probe: false };
  function permits(key) {
    const current = entry(key);
    if (current.state === 'CLOSED') return true;
    if (current.state === 'OPEN' && clock() - current.openedAt >= resetAfterMs) {
      current.state = 'HALF_OPEN'; current.probe = false; states.set(key, current);
    }
    if (current.state === 'OPEN' || current.probe) return false;
    current.probe = true; states.set(key, current); return true;
  }
  async function execute(key, operation) {
    if (!permits(key)) throw Object.assign(new Error('Provider circuit is open.'), { code: 'CIRCUIT_OPEN', busy: true });
    const current = entry(key);
    try {
      const result = await operation();
      states.set(key, { state: 'CLOSED', failures: 0, openedAt: 0, probe: false });
      return result;
    } catch (error) {
      current.probe = false;
      if (shouldTrip(error)) {
        current.failures += 1;
        if (current.state === 'HALF_OPEN' || current.failures >= failureThreshold) {
          current.state = 'OPEN'; current.openedAt = clock();
        }
      } else if (current.state === 'HALF_OPEN') {
        current.state = 'CLOSED'; current.failures = 0; current.openedAt = 0;
      }
      states.set(key, current);
      throw error;
    }
  }
  return {
    execute,
    permits,
    reset(key) { states.delete(key); },
    snapshot(key) { const s=entry(key); return { state:s.state, failures:s.failures, openedAt:s.openedAt }; },
    resetAll() { states.clear(); }
  };
}

function defaultShouldTrip(error) {
  const status=Number(error?.status)||0;
  return status===429 || status>=500 || error?.name==='TimeoutError' || error?.name==='AbortError' || error?.code==='ECONNRESET' || error?.code==='ECONNREFUSED';
}
