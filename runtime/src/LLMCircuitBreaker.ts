export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export interface LLMProviderConfig { name: string; endpoint: string; apiKey?: string; model: string; timeoutMs?: number; allowInsecureHttp?: boolean }
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly code = 'PROVIDER_ERROR') { super(message); this.name = 'ProviderError'; }
}

export class LLMCircuitBreaker {
  private state: BreakerState = 'CLOSED'; private failures = 0; private openedAt = 0; private probing = false;
  constructor(readonly config: LLMProviderConfig, private readonly threshold = 3, private readonly recoveryMs = 30_000,
    private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(config.endpoint);
    const loopback = ['localhost','127.0.0.1','::1'].includes(url.hostname);
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback && !config.allowInsecureHttp) || !config.model || threshold < 1) throw new Error('Invalid LLM provider configuration.');
  }
  getState(): BreakerState { if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.recoveryMs) this.state = 'HALF_OPEN'; return this.state; }
  async execute(messages: Array<{ role: string; content: string }>, options: Record<string, unknown> = {}): Promise<string> {
    const state = this.getState();
    if (state === 'OPEN') throw new ProviderError(`Circuit open for ${this.config.name}`, undefined, 'CIRCUIT_OPEN');
    if (state === 'HALF_OPEN') {
      if (this.probing) throw new ProviderError(`Recovery probe already active for ${this.config.name}`, undefined, 'CIRCUIT_PROBE_BUSY');
      this.probing = true;
    }
    const timeoutMs = Math.max(250, Math.min(Number(options.timeoutMs) || this.config.timeoutMs || 15_000, 15_000));
    const { timeoutMs: _timeout, ...requestOptions } = options;
    try {
      const response = await this.fetcher(this.config.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ ...requestOptions, model: this.config.model, messages }), signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new ProviderError(`Provider HTTP ${response.status}`, response.status, response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR');
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; response?: string };
      const text = body.choices?.[0]?.message?.content || body.response;
      if (!text?.trim()) throw new ProviderError('Provider returned an empty response.', undefined, 'EMPTY_RESPONSE');
      this.failures = 0; this.state = 'CLOSED'; return text;
    } catch (error) {
      this.failures++; this.openedAt = Date.now();
      if (state === 'HALF_OPEN' || this.failures >= this.threshold || (error instanceof ProviderError && (error.status === 429 || (error.status || 0) >= 500))) this.state = 'OPEN';
      if (error instanceof Error && error.name === 'TimeoutError') throw new ProviderError('Provider request timed out.', undefined, 'TIMEOUT');
      throw error;
    } finally { this.probing = false; }
  }
}

export async function executeCascade(providers: LLMCircuitBreaker[], messages: Array<{ role: string; content: string }>, options: Record<string, unknown> = {}) {
  const attempts: Array<{ provider: string; code: string }> = [];
  for (const provider of providers) {
    try { return { text: await provider.execute(messages, options), provider: provider.config.name, attempts }; }
    catch (error) { attempts.push({ provider: provider.config.name, code: error instanceof ProviderError ? error.code : 'PROVIDER_ERROR' }); }
  }
  throw Object.assign(new Error('All configured LLM providers failed.'), { code: 'LLM_UNAVAILABLE', attempts });
}
