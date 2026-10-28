/**
 * Agentforge2 Core — Hochverfuegbare, selbstheilende Multi-Agenten-Basis.
 * Module: Redis-Event-Bus, Hierarchischer Supervisor, LLM-Circuit-Breaker,
 * OpenTelemetry-Telemetry. Alle Komponenten sind optional aktivierbar und
 * degradieren fehlertolerant (ohne Redis/Collector lauffaehig).
 */
export * from './infrastructure/RedisEventBus.js';
export * from './supervisor/HierarchicalSupervisor.js';
export * from './llm/LLMCircuitBreaker.js';
export * from './telemetry/AgentTelemetry.js';
import { RedisEventBus } from './infrastructure/RedisEventBus.js';
export interface CoreBootstrapOptions {
    redisUrl?: string | null;
    otelEndpoint?: string | null;
}
export interface CoreRuntime {
    eventBus: RedisEventBus | null;
    telemetryReady: boolean;
}
/** Sicherer Einstieg fuer den Produktions-Hub: keine Abhaengigkeit wirft. */
export declare function bootstrapCore(options?: CoreBootstrapOptions): Promise<CoreRuntime>;
