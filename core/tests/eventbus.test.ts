import { describe, it, expect, beforeEach } from 'vitest';
import { RedisEventBus, AgentEvent } from '../src/infrastructure/RedisEventBus.js';

/** Deterministischer Redis-Stub mit den fuer den Bus noetigen Stream-Kommandos. */
class FakeRedis {
  streams = new Map<string, Array<{ id: string; fields: string[] }>>();
  groups = new Map<string, Set<string>>();
  pending = new Map<string, Array<{ consumer: string; id: string; fields: string[] }>>();
  acked: Array<{ stream: string; group: string; id: string }> = [];
  private counter = 0;

  async xadd(...args: any[]): Promise<string | null> {
    const key = args[0];
    const i = args[1] === 'MAXLEN' ? 4 : 1;
    const fields = args.slice(i + 1);
    const id = `${Date.now()}-${++this.counter}`;
    if (!this.streams.has(key)) this.streams.set(key, []);
    this.streams.get(key)!.push({ id, fields });
    return id;
  }

  async xgroup(op: string, key: string, group: string, ..._rest: any[]): Promise<any> {
    if (op !== 'CREATE') throw new Error('nicht unterstuetzt: ' + op);
    const k = `${key}|${group}`;
    if (this.groups.has(k)) throw new Error('BUSYGROUP Consumer Group name already exists');
    this.groups.set(k, new Set());
    this.pending.set(k, []);
    return 'OK';
  }

  async xreadgroup(...args: any[]): Promise<any> {
    const group = args[1];
    const consumer = args[2];
    const count = Number(args[6]);
    const key = args[8];
    const k = `${key}|${group}`;
    if (!this.groups.has(k)) throw new Error('NOGROUP');
    const pending = this.pending.get(k)!;
    const deliver: Array<{ id: string; fields: string[] }> = [];
    for (const msg of this.streams.get(key) ?? []) {
      if (!pending.some((p) => p.id === msg.id) && !deliver.some((d) => d.id === msg.id)) {
        deliver.push(msg);
      }
      if (deliver.length >= count) break;
    }
    for (const d of deliver) pending.push({ consumer, id: d.id, fields: d.fields });
    if (deliver.length === 0) return null;
    return [[key, deliver.map((d) => [d.id, d.fields])]];
  }

  async xack(key: string, group: string, id: string): Promise<number> {
    this.acked.push({ stream: key, group, id });
    const pending = this.pending.get(`${key}|${group}`);
    if (pending) {
      const idx = pending.findIndex((p) => p.id === id);
      if (idx >= 0) pending.splice(idx, 1);
    }
    return 1;
  }

  async ping(): Promise<string> { return 'PONG'; }
  async quit(): Promise<void> { return; }
}

let fake: FakeRedis;

function createBus(): RedisEventBus {
  fake = new FakeRedis();
  return new RedisEventBus('redis://fake', { client: fake as any });
}

const sampleEvent: AgentEvent = {
  type: 'villa.task.completed',
  payload: { taskId: 42, result: 'ok' },
  timestamp: 1700000000000,
  agentId: 'agent-007',
};

describe('RedisEventBus', () => {
  beforeEach(() => { fake = new FakeRedis(); });

  it('publiziert Events typsicher und liefert Message-IDs', async () => {
    const bus = createBus();
    const id = await bus.publish('villa:events', sampleEvent);
    expect(id).toBeTruthy();
    const stored = (fake.streams.get('villa:events') ?? []).at(-1)!;
    expect(stored.fields).toEqual([
      'type', 'villa.task.completed',
      'payload', JSON.stringify({ taskId: 42, result: 'ok' }),
      'timestamp', '1700000000000',
      'agentId', 'agent-007',
    ]);
  });

  it('roundtrip: publish -> consume -> acknowledge', async () => {
    const bus = createBus();
    const id = await bus.publish('villa:events', { ...sampleEvent, timestamp: 0 });
    const gen = bus.consumeStream('villa:events', 'orchestrator', 'consumer-1', 0);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value!.id).toBe(id);
    expect(first.value!.event.type).toBe('villa.task.completed');
    expect(first.value!.event.payload.taskId).toBe(42);
    expect(first.value!.event.agentId).toBe('agent-007');
    expect(first.value!.event.timestamp).toBeGreaterThan(0);
    await bus.acknowledge('villa:events', 'orchestrator', id);
    expect(fake.acked[0].id).toBe(id);
    bus.stop();
    const next = await gen.next();
    expect(next.done).toBe(true);
  });

  it('stellt Consumer-Group idempotent (BUSYGROUP wird toleriert)', async () => {
    const bus = createBus();
    await bus.ensureConsumerGroup('villa:events', 'group-a');
    await expect(bus.ensureConsumerGroup('villa:events', 'group-a')).resolves.toBeUndefined();
  });

  it('meldet Health-Check gruen', async () => {
    const bus = createBus();
    expect(await bus.healthCheck()).toBe(true);
  });
});
