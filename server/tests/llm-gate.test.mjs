/**
 * Tests fuer die globale LLM-Begrenzung (llm.mjs).
 * Ziel: egal wie viele Villen/Agenten gleichzeitig anfragen, laufen hoechstens
 * VF_LLM_MAX_CONCURRENT Aufrufe parallel; alle Aufrufe werden trotzdem bedient.
 */
import './_env.mjs';
process.env.VF_LLM_MAX_CONCURRENT = '2';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { db } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import { chat, llmGateStatus } from '../llm.mjs';

test('Hoechstens 2 LLM-Aufrufe laufen gleichzeitig, alle 10 werden bedient', async () => {
  let current = 0;
  let peak = 0;
  const server = http.createServer((req, res) => {
    current += 1;
    peak = Math.max(peak, current);
    setTimeout(() => {
      current -= 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake', choices: [{ message: { content: 'ok' } }] }));
    }, 60);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  seedRoutes();
  db.prepare('UPDATE routes SET enabled = 0').run();
  db.prepare(
    `INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used)
     VALUES (?, 'openai', ?, 'fake', '', 1, 1, 1, 1, 'NEW', 0, 0, 0)`
  ).run('Gate-Test', `http://127.0.0.1:${port}/v1`);

  const results = await Promise.all(
    Array.from({ length: 10 }, () => chat([{ role: 'user', content: 'hi' }], { timeoutMs: 5000 }))
  );
  server.close();

  assert.equal(results.length, 10);
  assert.ok(results.every((r) => r.content === 'ok'), 'jeder Aufruf bekommt eine Antwort');
  assert.ok(peak <= 2, `Spitze der Gleichzeitigkeit war ${peak}, erlaubt sind 2`);
  const g = llmGateStatus();
  assert.equal(g.max, 2);
  assert.equal(g.active, 0, 'alle Slots wieder frei');
  assert.equal(g.queued, 0);
});
