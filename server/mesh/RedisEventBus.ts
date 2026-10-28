import Redis from 'ioredis';

export type AgentEventType =
  | 'task.created' | 'agent.step.started' | 'tool.executed'
  | 'agent.failed' | 'checkpoint.saved' | (string & {});

export interface AgentEvent {
  id?: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  timestamp: number;
  agentId: string;
}

export interface ConsumedEvent {
  id: string;
  event: AgentEvent;
}

export class RedisEventBus {
  private readonly publisher: Redis;
  private readonly reader: Redis;
  private closed = false;

  constructor(redisUrl = process.env.REDIS_URL || 'redis://localhost:6379') {
    const options = {
      maxRetriesPerRequest: null as null,
      retryStrategy: (attempt: number) => Math.min(2000, 100 * 2 ** Math.min(attempt, 5)),
    };
    this.publisher = new Redis(redisUrl, { ...options, maxRetriesPerRequest: 3 });
    this.reader = new Redis(redisUrl, options);
  }

  async publish(streamKey: string, event: AgentEvent): Promise<string> {
    if (!streamKey || !event.type || !event.agentId) throw new Error('Invalid event envelope');
    const id = await this.publisher.xadd(
      streamKey, '*', 'type', event.type,
      'payload', JSON.stringify(event.payload),
      'timestamp', String(event.timestamp || Date.now()),
      'agentId', event.agentId,
    );
    if (!id) throw new Error('Redis XADD did not return a message ID');
    return id;
  }

  async ensureConsumerGroup(streamKey: string, groupName: string): Promise<void> {
    try {
      await this.publisher.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
    }
  }

  private decode(id: string, fields: string[]): ConsumedEvent {
    const data: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) data[fields[i]] = fields[i + 1];
    const payload: unknown = JSON.parse(data.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid event payload');
    if (!data.type || !data.agentId || !Number.isFinite(Number(data.timestamp))) throw new Error('Invalid event fields');
    return { id, event: { id, type: data.type, agentId: data.agentId, timestamp: Number(data.timestamp), payload: payload as Record<string, unknown> } };
  }

  async *consumeStream(
    streamKey: string, groupName: string, consumerName: string,
    blockMs = 5000, signal?: AbortSignal,
  ): AsyncGenerator<ConsumedEvent> {
    await this.ensureConsumerGroup(streamKey, groupName);
    let failures = 0;
    while (!this.closed && !signal?.aborted) {
      try {
        const response = await this.reader.xreadgroup(
          'GROUP', groupName, consumerName, 'BLOCK', blockMs,
          'COUNT', 10, 'STREAMS', streamKey, '>',
        ) as [string, [string, string[]][]][] | null;
        failures = 0;
        for (const [, messages] of response || []) {
          for (const [id, fields] of messages) {
            try {
              yield this.decode(id, fields);
            } catch (error) {
              // Do not ACK malformed events: they remain inspectable in the PEL.
              console.error('[RedisEventBus] malformed message', { streamKey, id, error });
            }
          }
        }
      } catch (error) {
        if (this.closed || signal?.aborted) break;
        console.error('[RedisEventBus] consume failed', { streamKey, error });
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, 250 * 2 ** Math.min(++failures, 5))));
      }
    }
  }

  async acknowledge(streamKey: string, groupName: string, messageId: string): Promise<void> {
    const count = await this.publisher.xack(streamKey, groupName, messageId);
    if (count !== 1) throw new Error('Redis ACK did not acknowledge a pending message');
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.reader.disconnect();
    await this.publisher.quit();
  }
}
