import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const client = source.slice(source.indexOf('async function api('), source.indexOf('let currentVilla'));
function apiWith(fetch) {
  return runInNewContext(`${client}; api`, { fetch, getToken: () => 'test-token', AbortSignal });
}
test('API client serialisiert den Body und erhält eigene Header', async () => {
  const api = apiWith(async (path, options) => {
    assert.equal(path, '/api/villas');
    assert.equal(options.body, '{"name":"Test"}');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.headers['X-Test'], 'yes');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, text: async () => '{"villaId":1}' };
  });
  assert.equal((await api('/api/villas', { method: 'POST', headers: { 'X-Test': 'yes' }, body: { name: 'Test' } })).villaId, 1);
});
test('HTTP-Fehler werden auch bei JSON ohne Fehlerfeld angezeigt', async () => {
  const api = apiWith(async () => ({ ok: false, status: 503, text: async () => '{}' }));
  assert.equal((await api('/api/stats')).error, 'HTTP 503');
});
test('Netzwerkverlust und Timeout ergeben bedienbare Fehlerantworten', async () => {
  const network = apiWith(async () => { throw new TypeError('fetch failed'); });
  assert.match((await network('/api/villas')).error, /nicht erreichbar/);
  const timeout = apiWith(async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); });
  assert.match((await timeout('/api/villas')).error, /zu langsam/);
});
