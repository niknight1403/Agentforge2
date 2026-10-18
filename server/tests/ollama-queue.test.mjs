import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OLLAMA_MAX_PARALLEL = '1';
process.env.OLLAMA_MAX_QUEUE = '2';
const llm = await import('../llm.mjs');
const q = llm._ollamaQueue;

test('Grenzen kommen aus der Umgebung, Statistik startet leer', () => {
  assert.deepEqual(llm.ollamaQueueStats(), { active: 0, waiting: 0, maxParallel: 1, maxQueue: 2 });
});

test('Nie mehr als 1 gleichzeitig; Wartende kommen der Reihe nach dran', async () => {
  const order = [];
  await q.acquire(); // Platz 1 belegt
  assert.equal(llm.ollamaQueueStats().active, 1);
  const w1 = q.acquire().then(() => order.push('w1'));
  const w2 = q.acquire().then(() => order.push('w2'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(llm.ollamaQueueStats().waiting, 2);
  assert.deepEqual(order, [], 'Wartende duerfen nicht vorlaufen');
  q.release(); await w1;                 // Platz geht an w1
  assert.deepEqual(order, ['w1']);
  assert.equal(llm.ollamaQueueStats().active, 1, 'Platz wird weitergereicht, nicht frei');
  q.release(); await w2;
  assert.deepEqual(order, ['w1', 'w2']);
  q.release();
  assert.deepEqual(llm.ollamaQueueStats(), { active: 0, waiting: 0, maxParallel: 1, maxQueue: 2 });
});

test('Volle Schlange wird sofort als busy abgelehnt (keine Routen-Sperre)', async () => {
  await q.acquire();
  const a = q.acquire(); const b = q.acquire();   // Schlange: 2 von 2
  await assert.rejects(q.acquire(), (e) => e.busy === true && /ausgelastet/.test(e.message));
  q.release(); await a; q.release(); await b; q.release();
  assert.equal(llm.ollamaQueueStats().active, 0);
});
