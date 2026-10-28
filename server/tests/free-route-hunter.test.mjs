/**
 * Tests Free Route Hunter (Ergaenzungsmodul zu free-route-cycle).
 * Laeuft offline gegen eine temporere DB (siehe _env.mjs, MUSS zuerst importiert werden).
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import {
  discoverLocalAndKeyless,
  integrate,
  classifyProbe,
  probeRoute,
  monitor,
  hunterTick,
  hunterStatus,
  weeklyReport,
  KEYLESS_CANDIDATES
} from '../free-route-hunter.mjs';

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data)
});

const fakeFetch = (handler) => async (url, opts) => handler(String(url), opts);

test('discoverLocalAndKeyless findet lokale Ollama-Modelle und keyfreie Endpunkte', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('/api/tags')) return jsonRes({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen:7b' }] });
    throw new Error('unerwartete URL: ' + url);
  });
  const { candidates, sources } = await discoverLocalAndKeyless({ fetchImpl });
  assert.equal(sources.find((s) => s.source === 'ollama:local').count, 2);
  assert.equal(candidates.filter((c) => c.provider === 'ollama').length, 2);
  assert.equal(candidates.filter((c) => c.provider === 'pollinations').length, KEYLESS_CANDIDATES.length);
  // Alle Kandidaten sind keyfrei.
  assert.equal(candidates.every((c) => !c.keyEnv), true);
});

test('discoverLocalAndKeyless vertraegt ausgefallenes Ollama', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({}, 503));
  const { candidates, sources } = await discoverLocalAndKeyless({ fetchImpl });
  assert.equal(sources.find((s) => s.source === 'ollama:local').ok, false);
  assert.equal(candidates.length >= 1, true, 'keyfreie Kandidaten bleiben');
});

test('integrate legt nur Neues an, ueberspringt Dubletten und Bezahltes', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM routes').get().n;
  const res = integrate([
    { name: 'Hunter Testroute A', provider: 'test', baseUrl: 'https://a.invalid/v1', model: 'm-a', keyEnv: '', priority: 33 },
    { name: 'Hunter Testroute A', provider: 'test', baseUrl: 'https://a.invalid/v1', model: 'm-a', keyEnv: '', priority: 33 },
    { name: 'Bezahlt', provider: 'test', baseUrl: 'https://b.invalid/v1', model: 'm-b', isFree: false }
  ]);
  assert.equal(res.added.length, 1);
  assert.equal(res.skipped.length, 2);
  assert.equal(res.skipped.some((s) => s.reason === 'nicht kostenlos'), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM routes').get().n, before + 1);
  const row = db.prepare('SELECT is_free, status FROM routes WHERE name = ?').get('Hunter Testroute A');
  assert.equal(row.is_free, 1);
  assert.equal(row.status, 'NEW');

  const again = integrate([{ name: 'Hunter Testroute A', provider: 'test', baseUrl: 'https://a.invalid/v1', model: 'm-a' }]);
  assert.equal(again.added.length, 0, 'zweiter Lauf legt nichts doppelt an');
});

test('classifyProbe bildet Statuscodes korrekt ab', () => {
  assert.equal(classifyProbe({ status: 429 }).state, 'COOLDOWN');
  assert.equal(classifyProbe({ status: 429 }).cooldownMs > 0, true);
  assert.equal(classifyProbe({ status: 401 }).state, 'DEAD');
  assert.equal(classifyProbe({ status: 403 }).enabled, 0);
  assert.equal(classifyProbe({ status: 500 }).state, 'ERROR');
  assert.equal(classifyProbe({ status: 0 }).state, 'UNREACHABLE');
  assert.equal(classifyProbe({ status: 200, ms: 90 }).state, 'OK');
});

test('probeRoute fragt ohne Key nicht an und schreibt Latenz bei Erfolg', async () => {
  const ins = db.prepare("INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES ('Keyroute', 'test', 'https://k.invalid/v1', 'k-model', 'HUNTER_TEST_KEY_MISSING', 1, 1, 30, 1, 'NEW', 0, 0, 0)").run();
  const keyRow = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(ins.lastInsertRowid));
  const noKey = await probeRoute(keyRow, { fetchImpl: async () => { throw new Error('darf nicht aufgerufen werden'); } });
  assert.equal(noKey.state, 'NOKEY');

  const ins2 = db.prepare("INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES ('Keylos', 'test', 'https://ok.invalid/v1', 'ok-model', '', 1, 1, 30, 1, 'NEW', 0, 0, 0)").run();
  const okRow = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(ins2.lastInsertRowid));
  let seen = null;
  const r = await probeRoute(okRow, {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return jsonRes({ ok: true }); }
  });
  assert.equal(r.state, 'OK');
  assert.equal(seen.url, 'https://ok.invalid/v1/chat/completions');
  assert.equal(JSON.parse(seen.opts.body).max_tokens, 1);
  const stored = db.prepare('SELECT status, ok, lat_ms FROM routes WHERE id = ?').get(okRow.id);
  assert.equal(stored.status, 'OK');
  assert.equal(stored.ok, 1);
  assert.equal(stored.lat_ms >= 0, true);
});

test('probeRoute schaltet bei 401 die Route ab', async () => {
  const ins = db.prepare("INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES ('Tot', 'test', 'https://dead.invalid/v1', 'dead-model', '', 1, 1, 30, 1, 'NEW', 0, 0, 0)").run();
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(ins.lastInsertRowid));
  const r = await probeRoute(row, { fetchImpl: async () => jsonRes({}, 401) });
  assert.equal(r.state, 'DEAD');
  const after = db.prepare('SELECT enabled, dead, status FROM routes WHERE id = ?').get(row.id);
  assert.equal(after.enabled, 0);
  assert.equal(after.status, 'DEAD');
});

test('monitor prueft ausschliesslich aktive Routen', async () => {
  const rows = await monitor({ limit: 40, fetchImpl: async () => jsonRes({ ok: true }) });
  assert.equal(rows.length > 0, true);
  const disabled = db.prepare("SELECT COUNT(*) n FROM routes WHERE enabled = 0 AND provider != 'offline'").get().n;
  assert.equal(typeof disabled, 'number');
});

test('hunterTick protokolliert den Zyklus, hunterStatus und weeklyReport lesen ihn', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('openrouter.ai')) return jsonRes({ data: [{ id: 'x:free', pricing: { prompt: '0', completion: '0' } }] });
    if (url.includes('/api/tags')) return jsonRes({ models: [] });
    return jsonRes({ ok: true });
  });
  const run = await hunterTick({ fetchImpl, monitorLimit: 2 });
  assert.equal(typeof run.ts, 'number');
  assert.equal(run.openrouter.ok, true);

  const st = hunterStatus();
  assert.equal(st.routes.total > 0, true);
  assert.equal(Array.isArray(st.top), true);
  assert.equal(st.runs.length >= 1, true);
  assert.equal(typeof st.growth7d, 'number');

  const { markdown, stats } = weeklyReport();
  assert.match(markdown, /Free Route Hunter — Wochenbericht/);
  assert.match(markdown, /Neue Routen in 7 Tagen/);
  assert.equal(typeof stats.addedWeek, 'number');
});

test('integrate ueberspringt unvollstaendige Kandidaten ohne die Runde abzubrechen', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM routes').get().n;
  const res = integrate([
    { name: 'Ohne Modell', provider: 'test', baseUrl: 'https://y.invalid/v1' },
    { name: '', provider: 'test', baseUrl: 'https://z.invalid/v1', model: 'mz' },
    { name: 'Gueltig danach', provider: 'test', baseUrl: 'https://ok.invalid/v1', model: 'm-ok' }
  ]);
  assert.equal(res.added.length, 1, 'gueltiger Kandidat nach defekten wird noch angelegt');
  assert.equal(res.skipped.length, 2);
  assert.equal(res.skipped.every((s) => s.reason === 'unvollstaendig'), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM routes').get().n, before + 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM routes WHERE name = '' OR model = ''").get().n, 0, 'keine kaputten Zeilen');
});
