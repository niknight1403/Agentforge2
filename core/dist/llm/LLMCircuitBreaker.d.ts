export interface LLMProviderConfig {
    name: string;
    endpoint: string;
    apiKey?: string;
    model: string;
    timeoutMs?: number;
}
export declare enum BreakerState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN"
}
export type TransportFn = (endpoint: string, body: Record<string, any>, headers: Record<string, string>, timeoutMs: number) => Promise<{
    data: any;
}>;
/**
 * Circuit-Breaker pro LLM-Provider: CLOSED -> OPEN bei Schwellwert oder 429,
 * HALF_OPEN nach Recovery-Zeit, Einzel-Probe, zurueck zu CLOSED bei Erfolg.
 * Der Transport ist injizierbar (Tests, eigene Fetch-Implementierungen).
 */
export declare class LLMCircuitBreaker {
    private state;
    private failureCount;
    private lastFailureTime;
    private failureThreshold;
    private recoveryTimeMs;
    private config;
    private transport;
    constructor(config: LLMProviderConfig, failureThreshold?: number, recoveryTimeMs?: number, transport?: TransportFn);
    execute(prompt: string, options?: Record<string, any>): Promise<string>;
    getState(): BreakerState;
    get providerName(): string;
}
