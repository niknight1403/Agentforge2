import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKDIR = mkdtempSync(join(tmpdir(), 'vf-gate-e2e-'));
process.env.VF_DB = join(WORKDIR, 'test.db');
process.env.DEEP_DIR = join(WORKDIR, 'deep');
process.env.PORT = String(47000 + Math.floor(Math.random() * 2000));
process.env.HOST = '127.0.0.1';

const { upsertUser } = await import('../auth.mjs');
const { server } = await import('../server.mjs');

after(() => server.close());

const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function api(path, opts = {}, token) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { ...opts, headers });
  return { status: r.status, body: await r.json() };
}

async function tokenFor(email) {
  upsertUser({ email, password: 'pass1234', role: 'admin', plan: 'pro' });
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'pass1234' }) });
  return login.body.token;
}

test('Develop-Endpunkt verweigert die Villa, solange kein Produkt belegt ist', async () => {
  const token = await tokenFor('gate-block@example.com');
  const created = await api('/api/deep/projects', {
    method: 'POST',
    body: JSON.stringify({ idea: 'Eine App, die Rechnungen fuer Freelancer erzeugt und als CSV exportiert.' }),
  }, token);
  const projectId = Number(created.body?.project?.id || created.body?.id);
  assert.ok(projectId > 0, JSON.stringify(created.body));

  const res = await api(`/api/deep/projects/${projectId}/develop`, { method: 'POST', body: '{}' }, token);
  assert.equal(res.status, 409);
  assert.equal(res.body.gateBlocked, true);
  assert.equal(res.body.villaId, 0);
  const keys = res.body.blockers.map((b) => b.key);
  assert.ok(keys.includes('source'), JSON.stringify(res.body.blockers));
  assert.ok(keys.includes('tests'));
  assert.ok(keys.includes('verification'));
  assert.match(res.body.message, /Produkt-Gate nicht erfuellt/);
});

test('Mit belegtem Produkt im Projektordner passiert das Gate', async () => {
  const token = await tokenFor('gate-pass@example.com');
  const created = await api('/api/deep/projects', {
    method: 'POST',
    body: JSON.stringify({ idea: 'Ein kleiner Rechnungsgenerator mit CSV-Export fuer Selbststaendige.' }),
  }, token);
  const projectId = Number(created.body?.project?.id || created.body?.id);
  assert.ok(projectId > 0);

  const dir = join(process.env.DEEP_DIR, String(projectId));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const start=()=>"ok";');
  writeFileSync(join(dir, 'src', 'invoice.mjs'), 'export const total=(a)=>a;');
  writeFileSync(join(dir, 'docs-spec.md'), '# Spezifikation\n' + 'Rechnung anlegen, Positionen erfassen, CSV exportieren. '.repeat(6));
  writeFileSync(join(dir, 'acceptance.json'), JSON.stringify({ criteria: ['Rechnung anlegen', 'CSV exportieren'] }));
  writeFileSync(join(dir, 'app.test.mjs'), 'test("ok",()=>{});');
  writeFileSync(join(dir, 'README.md'), '# Rechnungen\n\nStart: npm start\n');
  writeFileSync(join(dir, 'verification.json'), JSON.stringify({
    build: { status: 'passed' },
    tests: { status: 'passed' },
    userFlow: { status: 'passed' },
  }));

  const res = await api(`/api/deep/projects/${projectId}/develop`, { method: 'POST', body: '{}' }, token);
  // Das Gate laesst durch: keine Gate-Blockade mehr. Ob danach eine Villa
  // entsteht, haengt am Sprachmodell - in der Testumgebung sind keine
  // Cloud-Keys gesetzt, deshalb ist LLM_UNAVAILABLE hier das erwartete,
  // ehrliche Ergebnis und kein Gate-Fehler.
  assert.equal(res.body.gateBlocked, undefined, JSON.stringify(res.body));
  if (res.body.error) {
    assert.equal(res.body.code, 'LLM_UNAVAILABLE', JSON.stringify(res.body));
  } else {
    assert.ok(Number(res.body.villaId) > 0, JSON.stringify(res.body));
  }
});
