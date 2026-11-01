import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-health-shape-')), 'test.db');
process.env.PORT = String(42400 + Math.floor(Math.random() * 300));
process.env.HOST = '127.0.0.1';
delete process.env.REDIS_URL;

const { server } = await import('../server.mjs');
after(() => server.close());

const BASE = `http://127.0.0.1:${process.env.PORT}`;

test('/api/health liefert alle Pflichtfelder, die Deploy-Gates und Watchdogs erwarten', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const h = await res.json();

  for (const key of ['ok', 'version', 'routes', 'llm', 'cmd', 'scheduler', 'masterControl', 'capabilities']) {
    assert.ok(key in h, `Pflichtfeld fehlt: ${key}`);
  }
  assert.equal(h.ok, true);
  assert.equal(typeof h.version, 'string');
  assert.ok(h.version.length > 0);
  assert.ok(h.masterControl, 'masterControl muss gesetzt sein (PR #3 Health-Gate)');
  assert.ok(Array.isArray(h.capabilities), 'capabilities muss eine Liste sein');
  assert.ok(h.capabilities.includes('master-control-v1'), 'capabilities muss master-control-v1 nennen');
  assert.ok(h.capabilities.includes('llm-cascade-v1'), 'capabilities muss llm-cascade-v1 nennen');
  assert.ok(h.capabilities.includes('mcp-gateway-v1'), 'capabilities muss mcp-gateway-v1 nennen');

  // Betriebsdaten fuer Monitoring: Wert vorhanden, Form bleibt flexibel (Zahl oder Objekt).
  for (const key of ['routes', 'llm', 'cmd', 'scheduler']) {
    assert.notEqual(h[key], undefined, `${key} darf nicht undefined sein`);
    assert.notEqual(h[key], null, `${key} darf nicht null sein`);
  }
});

test('/api/health bleibt ohne Auth erreichbar (Deploy-Gate und Watchdog)', async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: { authorization: 'Bearer voellig-falsch' } });
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.ok, true);
});
