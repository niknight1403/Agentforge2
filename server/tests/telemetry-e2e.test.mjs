import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKDIR = mkdtempSync(join(tmpdir(), 'vf-telemetry-e2e-'));
process.env.VF_DB = join(WORKDIR, 'test.db');
process.env.VF_WORKSPACE = join(WORKDIR, 'ws');
process.env.PORT = String(49000 + Math.floor(Math.random() * 800));
process.env.HOST = '127.0.0.1';

const { upsertUser } = await import('../auth.mjs');
const { server } = await import('../server.mjs');
const { recordBuildResult } = await import('../telemetry.mjs');
const { db, now } = await import('../db.mjs');

after(() => server.close());

const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function api(path, opts = {}, token) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

async function tokenFor(email) {
  upsertUser({ email, password: 'pass1234', role: 'admin', plan: 'pro' });
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'pass1234' }) });
  return login.body.token;
}

test('Telemetrie-Endpunkt liefert die drei Kennzahlen mit Stichproben', async () => {
  const token = await tokenFor('telemetry@example.com');
  // Villa direkt anlegen: der POST-Endpunkt braucht ein Sprachmodell, das in
  // der Testumgebung fehlt. Geprueft wird hier der Telemetrie-Endpunkt selbst.
  // Villa vor einer Minute angelegt: die Builds unten liegen danach.
  const t = now() - 60_000;
  db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES ('Telemetrie-Villa','Eine Villa, die ein kleines Produkt baut','CREATED',100,1,?,?)").run(t, t);
  const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
  assert.ok(villaId > 0);

  recordBuildResult({ villaId, status: 'failed', ok: false, startedAt: now() - 5000, finishedAt: now() - 4000, error: 'Testfehler' });
  recordBuildResult({ villaId, status: 'ready', ok: true, startedAt: now() - 3000, finishedAt: now() - 1000 });

  const res = await api(`/api/metrics/telemetry?villaId=${villaId}`, {}, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.buildGreenRate.samples, 2);
  assert.equal(res.body.buildGreenRate.rate, 50);
  assert.equal(res.body.timeToFirstWorking.samples >= 1, true);
  assert.equal(typeof res.body.reworkQuote.samples, 'number');
  assert.equal(res.body.scope.villaId, villaId);
});

test('Globaler Aufruf ohne Villa liefert eine Zusammenfassung ueber alle Villen', async () => {
  const token = await tokenFor('telemetry-global@example.com');
  const res = await api('/api/metrics/telemetry', {}, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.buildGreenRate.samples, 'number');
  assert.equal(Array.isArray(res.body.notes), true);
});

test('Endpunkt verlangt Anmeldung', async () => {
  const res = await api('/api/metrics/telemetry');
  assert.ok([401, 403].includes(res.status), `Status war ${res.status}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM build_events').get().c > 0, true);
});
