import axios from 'axios';

export interface LLMProviderConfig {
  name: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

export enum BreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export type TransportFn = (
  endpoint: string,
  body: Record<string, any>,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<{ data: any }>;

const defaultTransport: TransportFn = async (endpoint, body, headers, timeoutMs) =>
  axios.post(endpoint, body, { headers, timeout: timeoutMs });

/**
 * Circuit-Breaker pro LLM-Provider: CLOSED -> OPEN bei Schwellwert oder 429,
 * HALF_OPEN nach Recovery-Zeit, Einzel-Probe, zurueck zu CLOSED bei Erfolg.
 * Der Transport ist injizierbar (Tests, eigene Fetch-Implementierungen).
 */
export class LLMCircuitBreaker {
  private state: BreakerState = BreakerState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private failureThreshold: number;
  private recoveryTimeMs: number;
  private config: LLMProviderConfig;
  private transport: TransportFn;

  constructor(
    config: LLMProviderConfig,
    failureThreshold: number = 3,
    recoveryTimeMs: number = 30_000,
    transport: TransportFn = defaultTransport
  ) {
    this.config = config;
    this.failureThreshold = failureThreshold;
    this.recoveryTimeMs = recoveryTimeMs;
    this.transport = transport;
  }

  public async execute(prompt: string, options?: Record<string, any>): Promise<string> {
    if (this.state === BreakerState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeMs) {
        this.state = BreakerState.HALF_OPEN;
      } else {
        throw new Error(`Circuit OPEN for provider '${this.config.name}'`);
      }
    }

    try {
      const response = await this.transport(
        this.config.endpoint,
        { model: this.config.model, messages: [{ role: 'user', content: prompt }], ...options },
        {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        this.config.timeoutMs || 15_000
      );
      this.state = BreakerState.CLOSED;
      this.failureCount = 0;
      const data = response.data;
      return data.choices?.[0]?.message?.content || data.response || JSON.stringify(data);
    } catch (error: any) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      if (this.failureCount >= this.failureThreshold || error.response?.status === 429) {
        this.state = BreakerState.OPEN;
      }
      throw error;
    }
  }

  public getState(): BreakerState {
    return this.state;
  }

  public get providerName(): string {
    return this.config.name;
  }
}
