#!/usr/bin/env node
/**
 * Startet den Worker-Dienst der Full-Stack-Engine.
 *
 *   npm run worker:fullstack
 *
 * Der Worker liest Bauauftraege vom Stream `agentforge:events:stream`
 * (VF_FULLSTACK_EVENT_STREAM), veroeffentlicht dort seine Ereignisse und
 * schreibt seinen Zustand nach server/data/fullstack/worker-health.json.
 * Ohne Redis beendet er sich mit klarer Meldung statt still zu warten.
 */
import { startFullstackWorker } from '../server/fullstack/worker.mjs';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} empfangen, beende nach laufendem Auftrag.`);
    controller.abort();
  });
}

const worker = await startFullstackWorker({ signal: controller.signal, pollMs: Number(process.env.VF_FULLSTACK_POLL_MS) || 1500 });
if (!worker.ok) {
  console.error('[worker] kein Betrieb moeglich:', worker.reason === 'redis_unavailable'
    ? 'Redis ist nicht erreichbar (REDIS_URL/VF_REDIS_URL pruefen).'
    : worker.reason);
  process.exit(1);
}
console.log(`[worker] bereit: stream=${worker.stream} group=${worker.group} consumer=${worker.consumer}`);
await worker.done;
console.log('[worker] beendet.');
