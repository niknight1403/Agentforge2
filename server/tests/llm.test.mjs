import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import { chat, pickRoute, resolveKey, keyStatus, enabledRoutes } from '../llm.mjs';

/** Definierter Zustand: frischer Routen-Katalog, keine Secrets. */
function resetRoutes() {
  db.prepare('DELETE FROM routes').run();
  db.prepare('DELETE FROM secrets').run();
  seedRoutes();
}

function setSecret(name, value) {
  db.prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(name, value, now());
}

test('resolveKey: Secrets-Store hat Vorrang vor Umgebung', () => {
  process.env.VF_TEST_KEY_ENV = 'aus-env';
  setSecret('VF_TEST_KEY_ENV', 'aus-store');
  assert.equal(resolveKey('VF_TEST_KEY_ENV'), 'aus-store');
  delete process.env.VF_TEST_KEY_ENV;
});

test('resolveKey: ohne beides bleibt leer', () => {
  assert.equal(resolveKey('VF_GIBT_ES_NICHT_XYZ'), '');
  assert.equal(resolveKey(''), '');
});

test('keyStatus: nur Namen, niemals Werte', () => {
  setSecret('STATUS_KEY', 'geheimer-wert-123');
  const s = keyStatus();
  assert.ok(s.stored.includes('STATUS_KEY'));
  assert.ok(!JSON.stringify(s).includes('geheimer-wert-123'), 'Wert darf nicht erscheinen');
});

test('pickRoute: ohne Keys bleibt nur die lokale Route, sonst Offline', () => {
  resetRoutes();
  // Ohne fremde Keys ist nur die lokale Route (Ollama, kein Key noetig) nutzbar.
  assert.equal(pickRoute().provider, 'ollama');
  // Ohne lokale Route bleibt nur der Offline-Planer.
  db.prepare('DELETE FROM routes WHERE provider != ?').run('groq');
  assert.equal(pickRoute().provider, 'offline');
});

test('pickRoute: mit Key waehlt die Route mit bester Prioritaet', () => {
  resetRoutes();
  setSecret('GROQ_API_KEY', 'test-key');
  assert.equal(pickRoute().provider, 'groq');
});

test('pickRoute ROTATE: bei gleicher Prioritaet die laengst unbenutzte Route', () => {
  resetRoutes();
  setSecret('GROQ_API_KEY', 'a');
  setSecret('CEREBRAS_API_KEY', 'b');
  // Gleiche Prioritaet erzwingen, sonst dominiert sie die Rotation.
  db.prepare('UPDATE routes SET priority = 1 WHERE provider IN (?, ?)').run('groq', 'cerebras');
  db.prepare('UPDATE routes SET last_used = ? WHERE provider = ?').run(now(), 'groq');
  db.prepare('UPDATE routes SET last_used = ? WHERE provider = ?').run(now() - 1000, 'cerebras');
  assert.equal(pickRoute().provider, 'cerebras');
});

test('pickRoute: lokale Route ohne Key ist nutzbar (Ollama)', () => {
  resetRoutes();
  // Nur die lokale Route bleibt: sie braucht keinen Key.
  db.prepare('DELETE FROM routes WHERE provider != ?').run('ollama');
  const r = pickRoute();
  assert.equal(r.provider, 'ollama', 'lokale Route wird uebergangen');
});

test('pickRoute FALLBACK: immer die erste Route', () => {
  resetRoutes();
  setSecret('GROQ_API_KEY', 'a');
  setSecret('CEREBRAS_API_KEY', 'b');
  db.prepare('UPDATE routes SET last_used = ? WHERE provider = ?').run(now(), 'groq');
  assert.equal(pickRoute('FALLBACK').provider, 'groq');
});

test('pickRoute: gesperrte Route wird uebergangen', () => {
  resetRoutes();
  setSecret('GROQ_API_KEY', 'a');
  setSecret('CEREBRAS_API_KEY', 'b');
  db.prepare('UPDATE routes SET cooldown_until = ? WHERE provider = ?').run(now() + 60_000, 'groq');
  // Ohne die Sperrung wuerde Groq (Prioritaet 1) gewinnen.
  assert.equal(pickRoute().provider, 'cerebras');
});

test('chat: tote Route faellt auf Offline zurueck und sperrt sich', async () => {
  resetRoutes();
  // Nur Groq mit Key, aber auf einen garantiert toten lokalen Port.
  db.prepare('DELETE FROM routes WHERE provider != ?').run('groq');
  setSecret('GROQ_API_KEY', 'x');
  db.prepare('UPDATE routes SET base_url = ? WHERE provider = ?').run('http://127.0.0.1:9', 'groq');

  const out = await chat([{ role: 'user', content: 'Hallo' }], { mode: 'chat' });
  assert.equal(out.offline, true, 'Offline-Fallback fehlt');
  assert.ok(out.warning, 'Warnung mit letztem Fehler fehlt');
  const row = db.prepare('SELECT * FROM routes WHERE provider = ?').get('groq');
  assert.equal(row.fail, 1, 'Fehlerzaehler nicht erhoeht');
  assert.equal(row.status, 'ERROR');
  assert.ok(Number(row.cooldown_until) > now(), 'Cooldown nicht gesetzt');
});

test('chat: Offline-Antwort im Planmodus liefert JSON-Plan', async () => {
  resetRoutes();
  const out = await chat(
    [
      { role: 'system', content: 'plane' },
      { role: 'user', content: 'Idee: Ein Todo-Tracker fuer Familien' }
    ],
    { json: true, mode: 'plan', agentCount: 6 }
  );
  const plan = JSON.parse(out.content);
  assert.ok(plan.summary && Array.isArray(plan.tasks) && plan.tasks.length >= 8);
  assert.ok(plan.tasks.every((t) => t.role && t.title && t.description), 'Tasks unvollstaendig');
});

test('chat: Offline-Antwort im Agentenmodus erfuellt den ReAct-Vertrag', async () => {
  resetRoutes();
  const out = await chat(
    [
      { role: 'system', content: 'agent' },
      { role: 'user', content: 'Was ist 2+2?' }
    ],
    { json: true, mode: 'agent' }
  );
  const parsed = JSON.parse(out.content);
  assert.ok('final' in parsed, 'ReAct-Vertrag verletzt: final fehlt');
});

test('enabledRoutes: nur aktivierte, nach Prioritaet sortiert', () => {
  resetRoutes();
  db.prepare('UPDATE routes SET enabled = 0 WHERE provider = ?').run('mistral');
  const list = enabledRoutes();
  assert.ok(!list.some((r) => r.provider === 'mistral'));
  const prios = list.map((r) => r.priority);
  assert.deepEqual(prios, [...prios].sort((a, b) => a - b));
});
