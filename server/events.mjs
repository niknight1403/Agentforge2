import { EventEmitter } from 'node:events';

/** Einfacher Event-Bus fuer SSE-Streaming an die Web-Oberflaeche. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emit(type, payload) {
  bus.emit('event', { type, ts: Date.now(), ...payload });
}
