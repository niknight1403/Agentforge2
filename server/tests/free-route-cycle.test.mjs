import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-free-routes-')), 'test.db');
const { db } = await import('../db.mjs');
const { scanFreeRoutes, freeRouteCycleStatus } = await import('../free-route-cycle.mjs');

test('scanner registers only official-catalog models with explicit zero input and output prices', async () => {
  const initialRoutes = db.prepare('SELECT COUNT(*) AS count FROM routes').get().count;
  const result = await scanFreeRoutes({
    clock: () => 500,
    fetchFn: async (url) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/models');
      return new Response(JSON.stringify({ data: [
        { id: 'vendor/free-coder:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'vendor/paid:free', pricing: { prompt: '0', completion: '0.000001' } },
        { id: 'vendor/no-price:free', pricing: {} },
        { id: 'https://evil.example/model:free', pricing: { prompt: '0', completion: '0' } }
      ] }), { status: 200 });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.discovered, 1);
  const route = db.prepare("SELECT * FROM routes WHERE model='vendor/free-coder:free'").get();
  assert.equal(route.provider, 'openrouter');
  assert.equal(route.is_free, 1);
  assert.equal(route.key_env, 'OPENROUTER_API_KEY');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM routes').get().count, initialRoutes + 1);
  assert.equal(freeRouteCycleStatus().summary.discoveredModels, 1);
  await scanFreeRoutes({ fetchFn: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
  assert.equal(db.prepare("SELECT enabled FROM routes WHERE model='vendor/free-coder:free'").get().enabled, 0);
  await scanFreeRoutes({ fetchFn: async () => new Response(JSON.stringify({ data: [
    { id: 'vendor/free-coder:free', pricing: { prompt: '0', completion: '0' } }
  ] }), { status: 200 }) });
  assert.equal(db.prepare("SELECT enabled FROM routes WHERE model='vendor/free-coder:free'").get().enabled, 1);
});

test('scan errors are recorded and do not create routes', async () => {
  const initialRoutes = db.prepare('SELECT COUNT(*) AS count FROM routes').get().count;
  const out = await scanFreeRoutes({ fetchFn: async () => new Response('unavailable', { status: 503 }) });
  assert.equal(out.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM routes').get().count, initialRoutes);
  assert.equal(freeRouteCycleStatus().latestScan.status, 'ERROR');
});
