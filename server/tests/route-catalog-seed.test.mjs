import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.VF_TEST = '1';
process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-route-catalog-')), 'db.sqlite');
delete process.env.VF_SELF_HOSTED_ALLOWED_HOSTS;

const { seedRouteCatalog, syncCascadeRoutes, syncFreeRouteFlags } = await import('../llm-config.mjs');
const { FREE_ROUTE_CATALOG } = await import('../routes.mjs');
const { db } = await import('../db.mjs');

test('provider catalog seeds free routes enabled and paid/credit routes disabled, idempotently', () => {
  const first = seedRouteCatalog();
  assert.equal(first.seeded, FREE_ROUTE_CATALOG.length);

  const groq = db.prepare("SELECT is_free,enabled FROM routes WHERE provider='groq' AND model='openai/gpt-oss-120b'").get();
  assert.deepEqual(groq, { is_free: 1, enabled: 1 });

  const local = db.prepare("SELECT is_free,enabled FROM routes WHERE provider='ollama' AND base_url='http://127.0.0.1:11434/v1'").get();
  assert.deepEqual(local, { is_free: 1, enabled: 1 });

  const cerebras = db.prepare("SELECT is_free,enabled FROM routes WHERE provider='cerebras' LIMIT 1").get();
  assert.deepEqual(cerebras, { is_free: 0, enabled: 0 });

  const xai = db.prepare("SELECT is_free,enabled FROM routes WHERE provider='xai' LIMIT 1").get();
  assert.deepEqual(xai, { is_free: 0, enabled: 0 });

  const oracleOllama = db.prepare("SELECT is_free,enabled FROM routes WHERE provider='ollama' AND base_url='https://ollama.cybersarah-ki.com/v1'").get();
  assert.deepEqual(oracleOllama, { is_free: 0, enabled: 0 });

  assert.equal(seedRouteCatalog().seeded, 0, 'repeat startup must not duplicate catalog rows');
  db.prepare("UPDATE routes SET enabled=0 WHERE provider='groq' AND model='openai/gpt-oss-120b'").run();
  seedRouteCatalog();
  assert.equal(db.prepare("SELECT enabled FROM routes WHERE provider='groq' AND model='openai/gpt-oss-120b'").get().enabled, 0,
    'existing administrator route decisions must be preserved');

  syncCascadeRoutes();
  syncFreeRouteFlags();
  const localReserve = db.prepare("SELECT is_free,enabled FROM routes WHERE name='Cascade: Local reserve'").get();
  assert.deepEqual(localReserve, { is_free: 1, enabled: 1 });
});
