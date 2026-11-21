/**
 * Tests Free Route Hunter (Ergaenzungsmodul zu free-route-cycle).
 * Laeuft offline gegen eine temporere DB (siehe _env.mjs, MUSS zuerst importiert werden).
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { isFreeRoute, syncFreeRouteFlags } from '../llm-config.mjs';
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
const completion = { choices: [{ message: { content: 'pong' } }] };

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
  assert.equal(classifyProbe({ status: 200, ms: 90, validResponse: true }).state, 'OK');
  assert.equal(classifyProbe({ status: 200, ms: 90, validResponse: false }).state, 'INVALID_RESPONSE');
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
    fetchImpl: async (url, opts) => { seen = { url, opts }; return jsonRes(completion); }
  });
  assert.equal(r.state, 'OK');
  assert.equal(seen.url, 'https://ok.invalid/v1/chat/completions');
  assert.equal(JSON.parse(seen.opts.body).max_tokens, 1);
  const stored = db.prepare('SELECT status, ok, lat_ms FROM routes WHERE id = ?').get(okRow.id);
  assert.equal(stored.status, 'OK');
  assert.equal(stored.ok, 1);
  assert.equal(stored.lat_ms >= 0, true);
});

test('probeRoute akzeptiert HTTP 200 ohne Modellantwort nicht als gesund', async () => {
  const ins = db.prepare("INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES ('Leere Antwort', 'test', 'https://empty.invalid/v1', 'empty-model', '', 1, 1, 30, 1, 'NEW', 0, 0, 0)").run();
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(ins.lastInsertRowid));
  const result = await probeRoute(row, { fetchImpl: async () => jsonRes({ choices: [{ message: { content: '   ' } }] }) });
  assert.equal(result.state, 'INVALID_RESPONSE');
  const stored = db.prepare('SELECT status, enabled, ok, fail FROM routes WHERE id = ?').get(row.id);
  assert.equal(stored.status, 'INVALID_RESPONSE');
  assert.equal(stored.enabled, 1, 'ein fehlerhaftes Payload darf die Route nicht dauerhaft deaktivieren');
  assert.equal(stored.ok, 0);
  assert.equal(stored.fail, 1);
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

test('monitor prueft ausschliesslich aktive kostenlose Routen', async () => {
  const paid = db.prepare("INSERT INTO routes (name,provider,base_url,model,key_env,is_free,enabled,priority,weight,status,ok,fail,last_used) VALUES ('Paid Hunter Guard','test','https://paid.invalid/v1','paid-model','',0,1,1,1,'NEW',0,0,0)").run();
  const free = db.prepare("INSERT INTO routes (name,provider,base_url,model,key_env,is_free,enabled,priority,weight,status,ok,fail,last_used) VALUES ('Free Hunter Guard','test','https://free.invalid/v1','free-model','',1,1,2,1,'NEW',0,0,0)").run();
  const seen = [];
  const rows = await monitor({ limit: 100, fetchImpl: async (url) => { seen.push(new URL(String(url))); return jsonRes(completion); } });
  assert.equal(rows.some((row) => row.id === Number(paid.lastInsertRowid)), false, 'kostenpflichtige Route darf nicht angefragt werden');
  assert.equal(rows.some((row) => row.id === Number(free.lastInsertRowid)), true, 'kostenlose aktive Route wird geprüft');
  assert.equal(seen.some((url) => url.hostname === 'paid.invalid' && url.pathname === '/v1/chat/completions'), false);
  assert.equal(seen.some((url) => url.hostname === 'free.invalid' && url.pathname === '/v1/chat/completions'), true);
});

test('hunterTick protokolliert den Zyklus, hunterStatus und weeklyReport lesen ihn', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('openrouter.ai')) return jsonRes({ data: [{ id: 'x:free', pricing: { prompt: '0', completion: '0' } }] });
    if (url.includes('/api/tags')) return jsonRes({ models: [] });
    return jsonRes(completion);
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

test('Pollinations keyless route bleibt nach Free-Flag-Sync kostenlos und nutzbar', () => {
  const candidate = KEYLESS_CANDIDATES[0];
  const route = { provider: candidate.provider, base_url: candidate.baseUrl, model: candidate.model };
  assert.equal(isFreeRoute(route), true);
  assert.equal(isFreeRoute({ ...route, base_url: 'https://attacker.invalid/openai' }), false);
  integrate([candidate]);
  const stored = db.prepare('SELECT id, provider, base_url, model, is_free FROM routes WHERE provider = ? AND base_url = ? AND model = ?').get(candidate.provider, candidate.baseUrl, candidate.model);
  assert.ok(stored, 'Hunter route wurde angelegt');
  syncFreeRouteFlags();
  const refreshed = db.prepare('SELECT is_free FROM routes WHERE id = ?').get(stored.id);
  assert.equal(refreshed.is_free, 1, 'Free-Flag darf beim Sync nicht auf 0 fallen');
});
