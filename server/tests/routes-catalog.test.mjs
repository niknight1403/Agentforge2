import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { seedRoutes, syncCatalog } from '../seed.mjs';
import { FREE_ROUTE_CATALOG } from '../routes.mjs';
import { pickRoute } from '../llm.mjs';

function setSecret(name, value) {
  db.prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(name, value, now());
}

test('Katalog: Groq-Eintraege nutzen gpt-oss (llama-3.3-70b-versatile entfaellt)', () => {
  const groqRoutes = FREE_ROUTE_CATALOG.filter((r) => r.baseUrl.includes('groq.com'));
  assert.ok(groqRoutes.length >= 2, 'Groq-Pool zu klein');
  for (const r of groqRoutes) {
    assert.match(r.model, /^openai\/gpt-oss-/, `veraltetes Groq-Modell: ${r.model}`);
  }
  assert.ok(!FREE_ROUTE_CATALOG.some((r) => r.model === 'llama-3.3-70b-versatile'), 'totes Modell im Katalog');
  assert.ok(!FREE_ROUTE_CATALOG.some((r) => r.model === 'meta-llama/llama-3.3-70b-instruct:free'), 'altes OpenRouter-Modell im Katalog');
});

test('Katalog: Prioritaeten bleiben eindeutig und sortierbar', () => {
  const prios = FREE_ROUTE_CATALOG.map((r) => r.priority);
  assert.equal(new Set(prios).size, prios.length, 'doppelte Prioritaeten');
  assert.deepEqual(prios, [...prios].sort((a, b) => a - b));
});

test('syncCatalog: bestehende DB haelt Modell-Aenderungen mit', () => {
  seedRoutes();
  // Alten Zustand simulieren: Modell aendern, wie es in einer Altdatenbank stünde.
  db.prepare("UPDATE routes SET model = 'llama-3.3-70b-versatile' WHERE provider = 'groq'").run();
  const changed = syncCatalog();
  assert.equal(changed, 1, 'genau die geaenderte Route muss erkannt werden');
  const row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
  assert.equal(row.model, 'openai/gpt-oss-120b');
  assert.equal(row.status, 'NEW');
  // Idempotenz: zweiter Aufruf aendert nichts mehr.
  assert.equal(syncCatalog(), 0);
});

test('syncCatalog: Statistiken und Einstellungen des Nutzers bleiben erhalten', () => {
  seedRoutes();
  db.prepare("UPDATE routes SET model = 'alt', enabled = 0, priority = 77, ok = 12, fail = 3 WHERE provider = 'mistral'").run();
  syncCatalog();
  const row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('mistral');
  assert.equal(row.model, 'mistral-small-latest', 'Modell aktualisiert');
  assert.equal(row.enabled, 0, 'enabled darf nicht zurueckgesetzt werden');
  assert.equal(row.priority, 77, 'priority darf nicht zurueckgesetzt werden');
  assert.equal(row.ok, 12, 'Statistik darf nicht zurueckgesetzt werden');
  assert.equal(row.fail, 3, 'Fehlerstatistik darf nicht zurueckgesetzt werden');
});

test('syncCatalog: geloeschte Routen bleiben geloescht (Nutzer-Intention)', () => {
  seedRoutes();
  db.prepare('DELETE FROM routes WHERE provider = ?').run('groq-2');
  // Wer eine Route bewusst loescht, will sie nicht bei jedem Start zurueck.
  assert.equal(syncCatalog(), 0, 'geloeschte Route wurde wiedereingefuegt');
  assert.ok(!db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq-2'));
});

test('pickRoute: Groq-Route ist weiter Prioritaet 1', () => {
  seedRoutes();
  setSecret('GROQ_API_KEY', 'k');
  const r = pickRoute();
  assert.equal(r.provider, 'groq');
  assert.equal(r.model, 'openai/gpt-oss-120b');
});
