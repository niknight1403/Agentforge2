// Sprint 9 — Rate-Limit-Haertung (CCC-Pattern): URL-Laenge (414), Burst-Circuit
// (429 + Retry-After: 30) und Body-Limit (413, 512 KB). Der Hub wird auf einem
// freien Port mit temporaerer DB gestartet; jede Pruefung nutzt eine eigene
// X-Forwarded-For-IP, damit sich die Fenster nicht gegenseitig beeinflussen.
// Start: node --test server/tests/rate-hardening.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-rate-')), 'test.db');
process.env.VF_WORKSPACE = join(mkdtempSync(join(tmpdir(), 'vf-rate-ws-')), 'workspace');
process.env.PORT = String(42800 + Math.floor(Math.random() * 200));
process.env.HOST = '127.0.0.1';
process.env.VF_VILLA_SLOTS = '1';

const { server } = await import('../server.mjs');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
after(() => server.close());

function call(path, { method = 'GET', body, ip } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip || '10.9.9.1' };
  return fetch(BASE + path, { method, headers, body });
}

test('URL-Laenge > 2000 Zeichen -> 414 mit JSON-Antwort', async () => {
  const r = await call('/api/villas?q=' + 'a'.repeat(2100), { ip: '10.0.0.1' });
  assert.equal(r.status, 414);
  const b = await r.json();
  assert.equal(b.code, 'URI_TOO_LONG');
  assert.ok(b.error.includes('URL zu lang'));
});

test('URL-Laenge <= 2000 Zeichen wird normal geroutet (kein 414)', async () => {
  const r = await call('/api/health?probe=' + 'a'.repeat(1000), { ip: '10.0.0.2' });
  assert.notEqual(r.status, 414);
  assert.ok(r.status === 200 || r.status === 401, `Health antwortet (${r.status})`);
});

test('Body > 512 KB -> 413 (Body-Limit in readBody)', async () => {
  const big = JSON.stringify({ email: 'x@example.com', password: 'p', pad: 'x'.repeat(600 * 1024) });
  const r = await call('/api/auth/login', { method: 'POST', body: big, ip: '10.0.0.3' });
  assert.equal(r.status, 413);
  const b = await r.json();
  assert.equal(b.code, 'BODY_TOO_LARGE');
});

test('Body unter 512 KB wird angenommen (kein 413)', async () => {
  const ok = JSON.stringify({ email: 'nobody@example.com', password: 'falsch', pad: 'x'.repeat(200 * 1024) });
  const r = await call('/api/auth/login', { method: 'POST', body: ok, ip: '10.0.0.4' });
  assert.notEqual(r.status, 413);
});

test('Burst-Circuit: 25 gleichzeitige Schreib-Anfragen derselben IP -> 429 + Retry-After: 30', async () => {
  const ip = '10.0.0.5';
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: `b${i}@example.com`, password: 'x' }), ip })
        .then(async (r) => ({ status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json() }))
    )
  );
  const blocked = results.filter((x) => x.status === 429);
  assert.ok(blocked.length >= 1, `mindestens eine 429 (bekommen: ${results.map((x) => x.status).join(',')})`);
  assert.ok(results.some((x) => x.status !== 429), 'die ersten Anfragen laufen normal durch');
  assert.equal(blocked[0].retryAfter, '30', 'Header Retry-After: 30');
  assert.equal(blocked[0].body.code, 'BURST_LIMIT');
  assert.equal(blocked[0].body.retryAfter, 30);
});

test('Burst-Circuit ist IP-basiert: andere IP bleibt frei', async () => {
  const r = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'free@example.com', password: 'x' }),
    ip: '10.0.0.6'
  });
  assert.notEqual(r.status, 429);
});

test('Lese-Anfragen (GET) loesen den Burst-Circuit nicht aus', async () => {
  const ip = '10.0.0.7';
  const results = await Promise.all(Array.from({ length: 30 }, () => call('/api/health', { ip }).then((r) => r.status)));
  assert.ok(results.every((s) => s !== 429), 'GET-Flood wird nicht als Write-Burst gewertet');
});
