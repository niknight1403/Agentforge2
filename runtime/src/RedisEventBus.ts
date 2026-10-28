import { Redis, type RedisOptions } from 'ioredis';
import { randomUUID } from 'node:crypto';

export interface AgentEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  id?: string;
  type: string;
  payload: T;
  timestamp: number;
  agentId: string;
}
export interface StreamMessage { id: string; event: AgentEvent }

const EVENT_TYPE = /^[a-z][a-z0-9_.-]{1,99}$/;
const safeObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export class RedisEventBus {
  private readonly redis: Redis;
  constructor(redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379', options: RedisOptions = {}) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 3, enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 100, 3000), ...options });
  }
  async publish(stream: string, event: AgentEvent): Promise<string> {
    if (!EVENT_TYPE.test(event.type) || !safeObject(event.payload) || !event.agentId || event.agentId.length > 160) throw new Error('Invalid agent event.');
    const id = await this.redis.xadd(stream, 'MAXLEN', '~', '100000', '*',
      'event', JSON.stringify({ ...event, id: event.id || randomUUID(), timestamp: event.timestamp || Date.now() }));
    if (!id) throw new Error('Redis did not return a stream message id.');
    return id;
  }
  async ensureConsumerGroup(stream: string, group: string): Promise<void> {
    try { await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM'); }
    catch (error) { if (!String(error).includes('BUSYGROUP')) throw error; }
  }
  async acknowledge(stream: string, group: string, messageId: string): Promise<void> {
    await this.redis.xack(stream, group, messageId);
  }
  async ping(): Promise<string> { return this.redis.ping(); }
  async *consumeStream(stream: string, group: string, consumer: string,
    { blockMs = 5000, claimIdleMs = 30_000, signal }: { blockMs?: number; claimIdleMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<StreamMessage> {
    await this.ensureConsumerGroup(stream, group);
    const reader = this.redis.duplicate();
    const abortReader = () => reader.disconnect();
    signal?.addEventListener('abort', abortReader, { once: true });
    let claimCursor = '0-0';
    try {
      while (!signal?.aborted) {
        try {
          const claimed = await reader.call('XAUTOCLAIM', stream, group, consumer, claimIdleMs, claimCursor, 'COUNT', '10') as [string, [string, string[]][], string[]?];
          claimCursor = claimed[0] || '0-0';
          const reclaimed = await this.decode(stream, group, claimed[1] || []);
          for (const message of reclaimed) yield message;
          const response = await reader.call('XREADGROUP', 'GROUP', group, consumer, 'BLOCK', blockMs, 'COUNT', '10', 'STREAMS', stream, '>') as [string, [string, string[]][]][] | null;
          for (const [, rows] of response || []) for (const message of await this.decode(stream, group, rows)) yield message;
        } catch (error) {
          if (signal?.aborted) break;
          console.error('[RedisEventBus] consume failed', { stream, group, error: String(error).slice(0, 240) });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } finally { signal?.removeEventListener('abort', abortReader); await reader.quit().catch(() => reader.disconnect()); }
  }
  private async decode(stream: string, group: string, rows: [string, string[]][]): Promise<StreamMessage[]> {
    const messages: StreamMessage[] = [];
    const invalid: Array<{ id: string; error: string }> = [];
    for (const [id, fields] of rows) {
      try {
        const record: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) record[fields[i]!] = fields[i + 1]!;
        const event = JSON.parse(record.event || '') as AgentEvent;
        if (!event || !EVENT_TYPE.test(event.type) || !safeObject(event.payload) || typeof event.agentId !== 'string' ||
            !event.agentId || !event.id || event.id.length > 180 || !Number.isFinite(event.timestamp)) throw new Error('Invalid event envelope.');
        messages.push({ id, event });
      } catch (error) {
        invalid.push({ id, error: String(error).slice(0, 200) });
      }
    }
    // Poison entries are copied to a bounded DLQ before acking to avoid a hot retry loop.
    for (const row of invalid) {
      await this.redis.xadd(`${stream}:dead`, 'MAXLEN', '~', '10000', '*', 'sourceId', row.id, 'error', row.error);
      await this.redis.xack(stream, group, row.id);
    }
    return messages;
  }
  async disconnect(): Promise<void> { await this.redis.quit(); }
}
