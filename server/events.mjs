import { EventEmitter } from 'node:events';
import { publishMeshEvent } from './event-mesh.mjs';

/** Einfacher Event-Bus fuer SSE-Streaming an die Web-Oberflaeche. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emit(type, payload) {
  const event={ type, ts: Date.now(), ...payload };
  bus.emit('event', event);
  // Durable metadata append is best-effort and never blocks the live scheduler.
  void publishMeshEvent(type,event).catch(()=>{});
}
