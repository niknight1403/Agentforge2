/** Deterministic per-provider breaker with a single half-open probe. */
export function createCircuitBreaker({ failureThreshold = 3, resetAfterMs = 30_000, clock = Date.now, shouldTrip = defaultShouldTrip } = {}) {
  const states = new Map();
  const entry = key => {
    if (!states.has(key)) states.set(key, { state: 'CLOSED', failures: 0, openedAt: 0, probe: false, generation: 0 });
    return states.get(key);
  };
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
    const generation = current.generation;
    try {
      const result = await operation();
      // A response started before a concurrent failure opened the circuit must
      // not silently close it again. Reset also invalidates in-flight results.
      if (states.get(key) === current && current.generation === generation) {
        current.state = 'CLOSED'; current.failures = 0; current.openedAt = 0; current.probe = false;
      }
      return result;
    } catch (error) {
      if (states.get(key) !== current || current.generation !== generation) throw error;
      current.probe = false;
      if (shouldTrip(error)) {
        current.failures += 1;
        if (current.state === 'HALF_OPEN' || current.failures >= failureThreshold) {
          current.state = 'OPEN'; current.openedAt = clock();
          current.generation += 1;
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
    snapshot(key) { const s=entry(key); return { state:s.state, failures:s.failures, openedAt:s.openedAt, retryAt:s.state==='OPEN'?s.openedAt+resetAfterMs:0 }; },
    resetAll() { states.clear(); }
  };
}

function defaultShouldTrip(error) {
  const status=Number(error?.status)||0;
  return status===429 || status>=500 || error?.name==='TimeoutError' || error?.name==='AbortError' || error?.code==='ECONNRESET' || error?.code==='ECONNREFUSED';
}
