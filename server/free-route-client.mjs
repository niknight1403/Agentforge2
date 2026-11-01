/** Read-only integration adapted from uploaded Free Router Hunter's LLM client.
 * The existing /api/free-routes remains the sole route authority.
 */
export class Agentforge2LlmRouteClient {
  #snapshot = { mode: 'FREE_ONLY', routes: [], fetchedAt: 0, stale: true };
  #pending;
  constructor({ baseUrl, token, freshnessMs = 30000, timeoutMs = 5000, fetchImpl = fetch, clock = Date.now }) {
    this.endpoint = new URL('/api/free-routes', baseUrl);
    const host = this.endpoint.hostname;
    if (this.endpoint.username || this.endpoint.password || !['https:', 'http:'].includes(this.endpoint.protocol) ||
        (this.endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(host))) throw new Error('HTTPS required except on loopback');
    for (const value of [freshnessMs, timeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw new Error('Invalid client time budget');
    if (token !== undefined && (typeof token !== 'string' || /[\r\n]/.test(token))) throw new Error('Invalid token');
    this.token = token; this.freshnessMs = freshnessMs; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl; this.clock = clock;
  }
  refresh() {
    if (!this.#pending) this.#pending = this.#refresh().finally(() => { this.#pending = undefined; });
    return this.#pending.then(value => structuredClone(value));
  }
  async #refresh() {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }
      });
      if (!response.ok) throw new Error(`Route API HTTP ${response.status}`);
      const data = await response.json();
      if (data?.mode !== 'FREE_ONLY' || !Array.isArray(data.routes) || data.routes.length > 500) throw new Error('Invalid route snapshot');
      const ids = new Set();
      const routes = data.routes.map(r => {
        if (!r || !Number.isSafeInteger(r.id) || r.id < 1 || ids.has(r.id) ||
            !['name', 'provider', 'model', 'status'].every(k => typeof r[k] === 'string' && r[k].length <= 500) ||
            typeof r.enabled !== 'boolean' || typeof r.available !== 'boolean' ||
            !['priority', 'successes', 'failures', 'cooldownUntil'].every(k => Number.isFinite(r[k]) && r[k] >= 0)) throw new Error('Invalid route entry');
        ids.add(r.id);
        return Object.fromEntries(['id', 'name', 'provider', 'model', 'status', 'enabled', 'available', 'priority', 'successes', 'failures', 'cooldownUntil'].map(k => [k, r[k]]));
      });
      this.#snapshot = { mode: 'FREE_ONLY', routes, fetchedAt: this.clock(), stale: false };
      return this.getSnapshot();
    } catch (error) {
      this.#snapshot.stale = true;
      // Do not include endpoint credentials, response body or provider errors.
      throw new Error(error?.message?.startsWith('Route API HTTP ') ? error.message : 'Route snapshot refresh failed');
    }
  }
  getSnapshot() {
    return { ...structuredClone(this.#snapshot), stale: this.#snapshot.stale || this.clock() - this.#snapshot.fetchedAt >= this.freshnessMs };
  }
  availableProviders() {
    const snapshot = this.getSnapshot();
    if (snapshot.stale) return [];
    return snapshot.routes.filter(r => r.enabled && r.available && r.cooldownUntil <= this.clock());
  }
}
