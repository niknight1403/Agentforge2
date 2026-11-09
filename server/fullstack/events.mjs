/**
 * Ereignis-Vertrag der Full-Stack-Engine auf dem Redis-Stream-Bus.
 *
 * Stream: `agentforge:events:stream` (per VF_FULLSTACK_EVENT_STREAM aenderbar).
 * Wie im restlichen Hub gilt: nur Metadaten. Kein Prompt, kein Dateiinhalt,
 * keine Modellantwort. Der Bauauftrag selbst bleibt beim Aufrufer.
 *
 * Zusaetzlich landet jedes Ereignis im Live-Bus (SSE), damit die Oberflaeche
 * denselben Fortschritt sieht wie der Stream-Consumer.
 */
import { randomUUID } from 'node:crypto';
import { emit as emitLive } from '../events.mjs';
import { redisTryStreamAdd } from '../redis.mjs';

export const FULLSTACK_EVENT_STREAM = process.env.VF_FULLSTACK_EVENT_STREAM || 'agentforge:events:stream';

export const FULLSTACK_EVENT_TYPES = Object.freeze([
  'PROJECT_PLANNED',
  'SCAFFOLD_GENERATED',
  'CONTAINER_TEST_PASSED',
  'CONTAINER_TEST_FAILED',
  'CHECKPOINT_SAVED',
  'STREAM_COMPLETE',
  'STREAM_FAILED',
]);

/** Whitelist: Feldname -> Typ. Alles andere wird verworfen, nie gekuerzt geraten. */
const SAFE_FIELDS = {
  slug: 'string',
  blueprintDigest: 'string',
  phase: 'string',
  status: 'string',
  code: 'string',
  commit: 'string',
  checkpointId: 'string',
  entities: 'number',
  routes: 'number',
  files: 'number',
  step: 'number',
  pass: 'number',
  failures: 'number',
  repairs: 'number',
  durationMs: 'number',
  testsPassed: 'number',
  testsFailed: 'number',
  ok: 'boolean',
};

export function buildFullstackEvent(type, payload = {}, { id = randomUUID, now = () => Date.now() } = {}) {
  if (!FULLSTACK_EVENT_TYPES.includes(type)) throw Object.assign(new Error(`Unbekannter Full-Stack-Event-Typ: ${type}`), { code: 'FULLSTACK_EVENT_TYPE_INVALID' });
  const event = { id: id(), type, at: now(), ok: type !== 'STREAM_FAILED' && type !== 'CONTAINER_TEST_FAILED' };
  for (const [key, kind] of Object.entries(SAFE_FIELDS)) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (kind === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) event[key] = Math.trunc(value);
      continue;
    }
    if (kind === 'boolean') {
      if (typeof value === 'boolean') event[key] = value;
      continue;
    }
    if (typeof value === 'string' && value) event[key] = value.slice(0, 160);
  }
  return event;
}

/** Schreibt das Ereignis in den Stream. Ohne Redis bleibt der Aufruf ehrlich erfolglos. */
export async function publishFullstackEvent(event, { stream = FULLSTACK_EVENT_STREAM } = {}) {
  const entryId = await redisTryStreamAdd(stream, { type: event.type, eventId: event.id, at: event.at, json: JSON.stringify(event) });
  return entryId ? { ok: true, stream, entryId } : { ok: false, stream, reason: 'redis_unavailable' };
}

/**
 * Erzeugt den Emitter fuer einen Bau. `sink` ist fuer Tests und den
 * Live-Betrieb austauschbar; standardmaessig geht es in den Redis-Stream.
 */
export function createFullstackEmitter({ sink, stream = FULLSTACK_EVENT_STREAM, onError = () => {} } = {}) {
  const events = [];
  const listener = sink || (event => publishFullstackEvent(event, { stream }));
  const send = async (type, payload = {}) => {
    const event = buildFullstackEvent(type, payload);
    events.push(event);
    try {
      emitLive(type, { phase: event.phase, status: event.status, ok: event.ok, step: event.step });
    } catch { /* Live-Bus ist Zusatz, der Stream bleibt fuehrend */ }
    try {
      await listener(event, { stream });
    } catch (error) {
      onError(error, event);
    }
    return event;
  };
  return { send, events, stream };
}
