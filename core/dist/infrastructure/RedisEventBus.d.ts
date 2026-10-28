import { Redis } from 'ioredis';
export interface AgentEvent {
    id?: string;
    type: string;
    payload: Record<string, any>;
    timestamp: number;
    agentId: string;
}
export interface StreamMessage {
    id: string;
    event: AgentEvent;
}
export interface EventBusOptions {
    /** Maximale Stream-Laenge (XADD MAXLEN ~) — 0 = unbegrenzt. */
    maxLen?: number;
    /** Retry-Verhalten des Clients. */
    maxRetriesPerRequest?: number;
    /** Bereits bestehender ioredis-Client (Tests, Pooling). Ohne wird einer erzeugt. */
    client?: Redis;
}
/**
 * Asynchroner Event-Bus auf Basis von Redis Streams mit Consumer-Groups.
 * Produktionstauglich: begrenzte Stream-Laenge, Lifecycle-Stop, Health-Check
 * und tolerante BUSYGROUP-Behandlung beim Anlegen bereits existierender Gruppen.
 */
export declare class RedisEventBus {
    private redis;
    private stopped;
    private readonly maxLen;
    private readonly owned;
    constructor(redisUrl?: string, options?: EventBusOptions);
    publish(streamKey: string, event: AgentEvent): Promise<string>;
    ensureConsumerGroup(streamKey: string, groupName: string): Promise<void>;
    consumeStream(streamKey: string, groupName: string, consumerName: string, blockMs?: number): AsyncGenerator<StreamMessage, void, unknown>;
    acknowledge(streamKey: string, groupName: string, messageId: string): Promise<void>;
    /** Beendet alle laufenden consumeStream-Generatoren geordnet. */
    stop(): void;
    /** Verbindungs-Health-Check fuer Supervisor und Uptime-Ueberwachung. */
    healthCheck(): Promise<boolean>;
    disconnect(): Promise<void>;
}
