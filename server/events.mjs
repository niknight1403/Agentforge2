import { EventEmitter } from 'node:events';

/** Einfacher Event-Bus fuer SSE-Streaming an die Web-Oberflaeche. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

let seq = 0;
const RING = []; // die letzten 200 Ereignisse fuer SSE-Replay
const RING_MAX = 200;

export function emit(type, payload) {
  const event = { id: ++seq, type, ts: Date.now(), ...payload };
  RING.push(event);
  if (RING.length > RING_MAX) RING.shift();
  bus.emit('event', event);
}

/** Alle Ereignisse mit id > since (fuer Last-Event-ID-Reconnects). */
export function eventsSince(since) {
  const from = Number(since) || 0;
  return RING.filter((e) => e.id > from);
}
