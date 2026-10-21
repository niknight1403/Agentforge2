/**
 * Sprint 6 (v1.37.0) — Gratis-Expansion.
 *
 * 1. Fuenf zusaetzliche Gratis-LLM-Routen (SambaNova, NVIDIA NIM, Zhipu
 *    GLM-4-Flash, Chutes.ai, Hyperbolic) im Katalog — Keys laufen wie
 *    immer ueber den Secrets-Store.
 * 2. Fuenf keylose Werkzeuge: wikipedia_search, hackernews_search,
 *    weather_lookup, currency_convert, package_info (Pack "open-data").
 * 3. Adaptive Routen-Intelligenz: Gewicht wächst mit Erfolg, schrumpft bei
 *    Fehlern; FALLBACK waehlt nach Score statt starrer Prioritaet.
 * 4. Echter-Code-Qualitaetstor: Code-Aufgaben muessen npm test am echten
 *    Projekt passieren, sonst einmal zurueck ins Backlog ([Q-GATE]).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'gratis-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');
process.env.VF_LLM_FREE_ONLY = '0'; // route tests exercise providers outside the default free cascade

const { FREE_ROUTE_CATALOG } = await import('../routes.mjs');
const { db, now } = await import('../db.mjs');
const { chat } = await import('../llm.mjs');
const { runTool, runQualityGate, setSource } = await import('../agents.mjs');
const { setPackEnabled, canUseTool } = await import('../packs.mjs');

test('Katalog enthaelt alle fuenf neuen Gratis-Provider mit Key-Env', () => {
  const want = {
    sambanova: 'https://api.sambanova.ai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    chutes: 'https://llm.chutes.ai/v1',
    hyperbolic: 'https://api.hyperbolic.xyz/v1'
  };
  for (const [provider, baseUrl] of Object.entries(want)) {
    const r = FREE_ROUTE_CATALOG.find((x) => x.provider === provider);
    assert.ok(r, `${provider} fehlt`);
    assert.equal(r.baseUrl, baseUrl);
    assert.ok(r.keyEnv.length > 0, `${provider} ohne keyEnv`);
  }
});

test('Wikipedia-Suche liefert Snippets mit Links (keylos)', async () => {
  const orig = globalThis.fetch;
  let called = null;
  globalThis.fetch = async (url) => {
    called = String(url);
    return new Response(JSON.stringify({ query: { search: [{ title: 'Kuenstliche Intelligenz', snippet: 'Die <b>KI</b> ist...' }] } }), { status: 200 });
  };
  try {
    const out = await runTool({ villaId: 1, agentId: 1 }, 'wikipedia_search', { query: 'künstliche intelligenz' });
    assert.ok(called.includes('de.wikipedia.org'), called);
    assert.match(out, /Kuenstliche Intelligenz/);
    assert.match(out, /wikipedia\.org\/wiki\//);
    assert.ok(!out.includes('<b>'), 'HTML entfernt');
  } finally { globalThis.fetch = orig; }
});

test('Hacker-News-Suche, Wetter und Waehrungen arbeiten keylos', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('hn.algolia.com')) return new Response(JSON.stringify({ hits: [{ objectID: '42', title: 'Show HN: VillaForge', points: 7, num_comments: 2 }] }), { status: 200 });
    if (u.includes('geocoding-api')) return new Response(JSON.stringify({ results: [{ name: 'Berlin', country: 'Deutschland', latitude: 52.5, longitude: 13.4 }] }), { status: 200 });
    if (u.includes('api.open-meteo.com')) return new Response(JSON.stringify({ current_weather: { temperature: 12, windspeed: 8 }, daily: { time: ['2026-10-14', '2026-10-15', '2026-10-16'], temperature_2m_min: [8, 7, 9], temperature_2m_max: [15, 14, 16], precipitation_sum: [0, 1.2, 0] } }), { status: 200 });
    if (u.includes('open.er-api.com')) return new Response(JSON.stringify({ time_last_update_utc: 'Wed, 14 Oct 2026', rates: { USD: 1.09, CHF: 0.94, GBP: 0.84, JPY: 163, CNY: 7.8 } }), { status: 200 });
    throw new Error('unerwartet: ' + u);
  };
  try {
    const hn = await runTool({ villaId: 1, agentId: 1 }, 'hackernews_search', { query: 'agent swarm' });
    assert.match(hn, /Show HN: VillaForge/);
    assert.match(hn, /item\?id=42/);
    const wetter = await runTool({ villaId: 1, agentId: 1 }, 'weather_lookup', { location: 'Berlin' });
    assert.match(wetter, /Berlin, Deutschland/);
    assert.match(wetter, /12°C/);
    const kurse = await runTool({ villaId: 1, agentId: 1 }, 'currency_convert', { base: 'EUR' });
    assert.match(kurse, /1 EUR = 1\.09 USD/);
  } finally { globalThis.fetch = orig; }
});

test('package_info liest npm- und PyPI-Registry keylos', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('registry.npmjs.org')) return new Response(JSON.stringify({ name: 'vite', 'dist-tags': { latest: '7.0.0' }, versions: { '7.0.0': { description: 'Next generation frontend tooling', license: 'MIT' } } }), { status: 200 });
    if (u.includes('pypi.org')) return new Response(JSON.stringify({ info: { name: 'fastapi', version: '0.115.0', summary: 'FastAPI framework' } }), { status: 200 });
    throw new Error('unerwartet: ' + u);
  };
  try {
    const npm = await runTool({ villaId: 1, agentId: 1 }, 'package_info', { name: 'vite' });
    assert.match(npm, /npm vite 7\.0\.0/);
    assert.match(npm, /MIT/);
    const py = await runTool({ villaId: 1, agentId: 1 }, 'package_info', { name: 'fastapi', registry: 'pypi' });
    assert.match(py, /PyPI fastapi 0\.115\.0/);
  } finally { globalThis.fetch = orig; }
});

test('Open-Data-Pack schaltet die keylosen Werkzeuge echt ab', () => {
  setPackEnabled('open-data', false);
  assert.equal(canUseTool('wikipedia_search').allowed, false);
  assert.equal(canUseTool('weather_lookup').allowed, false);
  setPackEnabled('open-data', true);
  assert.equal(canUseTool('wikipedia_search').allowed, true);
});

test('Adaptive Routen: Fehler schrumpfen Gewicht, Erfolg waechst es', async () => {
  const t = now();
  db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES ('Adapt-Villa','x','CREATED',10,1,?,?)").run(t, t);
  const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
  db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('AK1','k1',0)").run();
  db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('AK2','k2',0)").run();
  // Route A: faellt. Route B: funktioniert. Beide Prioritaet 1.
  db.prepare("INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES ('A','mock','https://a.invalid/v1','m','AK1',1,1,1,1,'NEW',0,0,0)").run();
  db.prepare("INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES ('B','mock','https://b.invalid/v1','m','AK2',1,1,1,1,'NEW',0,0,0)").run();

  const orig = globalThis.fetch;
  const order = [];
  globalThis.fetch = async (url) => {
    order.push(String(url));
    if (String(url).startsWith('https://a.invalid')) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    const out = await chat([{ role: 'user', content: 'hi' }], { strategy: 'FALLBACK' });
    assert.equal(out.content, 'ok');
    const a = db.prepare("SELECT weight, fail FROM routes WHERE name = 'A'").get();
    const b = db.prepare("SELECT weight, ok FROM routes WHERE name = 'B'").get();
    assert.ok(a.weight < 1, `A-Gewicht ${a.weight} sollte < 1 sein`);
    assert.equal(a.fail, 1);
    assert.ok(b.weight > 1, `B-Gewicht ${b.weight} sollte > 1 sein`);
    assert.equal(b.ok, 1);
    // Zweiter Lauf: Score-Sortierung muss B vor A versuchen.
    order.length = 0;
    await chat([{ role: 'user', content: 'hi' }], { strategy: 'FALLBACK' });
    assert.ok(order[0].startsWith('https://b.invalid'), `erster Versuch war ${order[0]}, sollte B sein`);
  } finally { globalThis.fetch = orig; }
});

test('Qualitaetstor: rotes npm test stoesst den Bounce aus, gruen besteht', async () => {
  const t = now();
  db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES ('Gate-Villa','x','CREATED',10,1,?,?)").run(t, t);
  const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
  const rot = join(tmp, 'projekt-rot');
  mkdirSync(rot, { recursive: true });
  writeFileSync(join(rot, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(1)"' } }));
  setSource(villaId, rot);

  const fail = await runQualityGate(villaId, { title: 'Feature bauen' }, 'Fertig.');
  assert.equal(fail.passed, false, 'roter Test muss den Tor reissen');
  assert.ok(/Exit|Nicht ausgefuehrt/.test(fail.output), 'Tor-Output erklaert das Scheitern: ' + String(fail.output).slice(0, 80));

  const gruen = join(tmp, 'projekt-gruen');
  mkdirSync(gruen, { recursive: true });
  writeFileSync(join(gruen, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }));
  setSource(villaId, gruen);
  const pass = await runQualityGate(villaId, { title: 'Feature bauen' }, 'Fertig.');
  assert.equal(pass.passed, true);
  assert.match(pass.annotated, /npm test gruen/);

  // Ein Retry-Marker darf die Prüfung nicht umgehen. Der Pack bleibt ein ausdrücklicher Administratorschalter.
  const retry = await runQualityGate(villaId, { title: 'Feature bauen [Q-GATE]' }, 'Fertig.');
  assert.equal(retry.passed,true);
  assert.equal(retry.skipped,undefined);
  setSource(villaId,rot);
  assert.equal((await runQualityGate(villaId,{title:'Feature bauen [Q-GATE]'},'Fertig.')).passed,false);
  setPackEnabled('qualitaetstor', false);
  const off = await runQualityGate(villaId, { title: 'Feature bauen' }, 'Fertig.');
  assert.equal(off.skipped, 'pack');
  setPackEnabled('qualitaetstor', true);
});

test('Qualitaetstor blockiert Projekte ohne Test-Script', async () => {
  const t = now();
  const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
  const leer = join(tmp, 'projekt-ohne-test');
  mkdirSync(leer, { recursive: true });
  writeFileSync(join(leer, 'package.json'), JSON.stringify({ name: 'p', scripts: { start: 'node x' } }));
  setSource(villaId, leer);
  const out = await runQualityGate(villaId, { title: 'Feature bauen' }, 'Fertig.');
  assert.equal(out.passed,false);
  assert.match(out.output,/Tests fehlen/);
});
