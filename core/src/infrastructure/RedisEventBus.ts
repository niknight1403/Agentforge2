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
export class RedisEventBus {
  private redis: Redis;
  private stopped = false;
  private readonly maxLen: number;
  private readonly owned: boolean;

  constructor(
    redisUrl: string = process.env.REDIS_URL || 'redis://localhost:6379',
    options: EventBusOptions = {}
  ) {
    if (options.client) {
      this.redis = options.client;
      this.owned = false;
    } else {
      const client = new Redis(redisUrl, {
        maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
        lazyConnect: false,
      });
      client.on('error', (err: Error) => {
        // Verbindungsfehler werden vom Retry-Strategy-Handler behandelt;
        // hier nur loggen, damit der Prozess nicht crasht.
        console.error('[RedisEventBus] Redis-Verbindungsfehler:', err.message);
      });
      this.redis = client;
      this.owned = true;
    }
    this.maxLen = options.maxLen ?? 100_000;
  }

  public async publish(streamKey: string, event: AgentEvent): Promise<string> {
    const timestamp = event.timestamp || Date.now();
    const args: any[] = this.maxLen > 0
      ? [streamKey, 'MAXLEN', '~', String(this.maxLen), '*']
      : [streamKey, '*'];
    args.push('type', event.type, 'payload', JSON.stringify(event.payload), 'timestamp', timestamp.toString(), 'agentId', event.agentId);
    const messageId = await (this.redis as any).xadd(...args);
    return messageId as string;
  }

  public async ensureConsumerGroup(streamKey: string, groupName: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
    } catch (err: any) {
      if (!err.message.includes('BUSYGROUP')) throw err;
    }
  }

  public async *consumeStream(
    streamKey: string,
    groupName: string,
    consumerName: string,
    blockMs: number = 5000
  ): AsyncGenerator<StreamMessage, void, unknown> {
    await this.ensureConsumerGroup(streamKey, groupName);

    while (!this.stopped) {
      try {
        const redisRaw = this.redis as unknown as { xreadgroup: (...args: any[]) => Promise<any> };
        const response = await redisRaw.xreadgroup(
          'GROUP', groupName, consumerName,
          'BLOCK', this.stopped ? 0 : blockMs,
          'COUNT', 10,
          'STREAMS', streamKey, '>'
        );

        if (response) {
          for (const [, messages] of response as [string, [string, string[]][]][]) {
            for (const [id, fields] of messages) {
              const eventData: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                eventData[fields[i]] = fields[i + 1];
              }

              try {
                const event: AgentEvent = {
                  id,
                  type: eventData.type,
                  payload: JSON.parse(eventData.payload ?? 'null'),
                  timestamp: Number(eventData.timestamp),
                  agentId: eventData.agentId,
                };
                yield { id, event };
              } catch (parseErr) {
                // Poison-Pill-Schutz: unlesbare Nachrichten bestätigen und
                // ueberspringen, damit der Consumer-Stream nicht blockiert.
                console.error(`[RedisEventBus] Ungueltige Nachricht ${id} in ${streamKey} uebersprungen:`, parseErr);
                await this.redis.xack(streamKey, groupName, id).catch(() => undefined);
              }
            }
          }
        }
      } catch (err) {
        if (this.stopped) return;
        console.error(`[RedisEventBus] Error consuming stream ${streamKey}:`, err);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  public async acknowledge(streamKey: string, groupName: string, messageId: string): Promise<void> {
    await this.redis.xack(streamKey, groupName, messageId);
  }

  /** Beendet alle laufenden consumeStream-Generatoren geordnet. */
  public stop(): void {
    this.stopped = true;
  }

  /** Verbindungs-Health-Check fuer Supervisor und Uptime-Ueberwachung. */
  public async healthCheck(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    this.stop();
    if (this.owned) await this.redis.quit().catch(() => undefined);
  }
}
