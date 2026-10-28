import { Redis } from 'ioredis';
/**
 * Asynchroner Event-Bus auf Basis von Redis Streams mit Consumer-Groups.
 * Produktionstauglich: begrenzte Stream-Laenge, Lifecycle-Stop, Health-Check
 * und tolerante BUSYGROUP-Behandlung beim Anlegen bereits existierender Gruppen.
 */
export class RedisEventBus {
    redis;
    stopped = false;
    maxLen;
    owned;
    constructor(redisUrl = process.env.REDIS_URL || 'redis://localhost:6379', options = {}) {
        if (options.client) {
            this.redis = options.client;
            this.owned = false;
        }
        else {
            const client = new Redis(redisUrl, {
                maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
                retryStrategy: (times) => Math.min(times * 50, 2000),
                lazyConnect: false,
            });
            client.on('error', (err) => {
                // Verbindungsfehler werden vom Retry-Strategy-Handler behandelt;
                // hier nur loggen, damit der Prozess nicht crasht.
                console.error('[RedisEventBus] Redis-Verbindungsfehler:', err.message);
            });
            this.redis = client;
            this.owned = true;
        }
        this.maxLen = options.maxLen ?? 100_000;
    }
    async publish(streamKey, event) {
        const timestamp = event.timestamp || Date.now();
        const args = this.maxLen > 0
            ? [streamKey, 'MAXLEN', '~', String(this.maxLen), '*']
            : [streamKey, '*'];
        args.push('type', event.type, 'payload', JSON.stringify(event.payload), 'timestamp', timestamp.toString(), 'agentId', event.agentId);
        const messageId = await this.redis.xadd(...args);
        return messageId;
    }
    async ensureConsumerGroup(streamKey, groupName) {
        try {
            await this.redis.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
        }
        catch (err) {
            if (!err.message.includes('BUSYGROUP'))
                throw err;
        }
    }
    async *consumeStream(streamKey, groupName, consumerName, blockMs = 5000) {
        await this.ensureConsumerGroup(streamKey, groupName);
        while (!this.stopped) {
            try {
                const redisRaw = this.redis;
                const response = await redisRaw.xreadgroup('GROUP', groupName, consumerName, 'BLOCK', this.stopped ? 0 : blockMs, 'COUNT', 10, 'STREAMS', streamKey, '>');
                if (response) {
                    for (const [, messages] of response) {
                        for (const [id, fields] of messages) {
                            const eventData = {};
                            for (let i = 0; i < fields.length; i += 2) {
                                eventData[fields[i]] = fields[i + 1];
                            }
                            try {
                                const event = {
                                    id,
                                    type: eventData.type,
                                    payload: JSON.parse(eventData.payload ?? 'null'),
                                    timestamp: Number(eventData.timestamp),
                                    agentId: eventData.agentId,
                                };
                                yield { id, event };
                            }
                            catch (parseErr) {
                                // Poison-Pill-Schutz: unlesbare Nachrichten bestätigen und
                                // ueberspringen, damit der Consumer-Stream nicht blockiert.
                                console.error(`[RedisEventBus] Ungueltige Nachricht ${id} in ${streamKey} uebersprungen:`, parseErr);
                                await this.redis.xack(streamKey, groupName, id).catch(() => undefined);
                            }
                        }
                    }
                }
            }
            catch (err) {
                if (this.stopped)
                    return;
                console.error(`[RedisEventBus] Error consuming stream ${streamKey}:`, err);
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
    }
    async acknowledge(streamKey, groupName, messageId) {
        await this.redis.xack(streamKey, groupName, messageId);
    }
    /** Beendet alle laufenden consumeStream-Generatoren geordnet. */
    stop() {
        this.stopped = true;
    }
    /** Verbindungs-Health-Check fuer Supervisor und Uptime-Ueberwachung. */
    async healthCheck() {
        try {
            return (await this.redis.ping()) === 'PONG';
        }
        catch {
            return false;
        }
    }
    async disconnect() {
        this.stop();
        if (this.owned)
            await this.redis.quit().catch(() => undefined);
    }
}
//# sourceMappingURL=RedisEventBus.js.map