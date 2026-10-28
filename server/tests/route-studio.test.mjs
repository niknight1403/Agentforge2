/**
 * Tests fuer das Routen-Studio. Offline: keine echten Netzzugriffe, eigene
 * temporaere Datenbank ueber GoSt _env.mjs.
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import {
  scoreRoute, eliteRanking, simulateChain, saveChain, listChains,
  buildChainFromGoal, recordSimulation, studioStatus,
} from '../route-studio.mjs';

function route(overrides = {}) {
  const t = now();
  const row = {
    name: 'R', provider: 'test', base_url: 'https://t.invalid/v1', model: 'm',
    key_env: '', is_free: 1, enabled: 1, priority: 10, weight: 1, status: 'OK',
    ok: 10, fail: 1, last_used: t, cooldown_until: 0, lat_ms: 400, tokens: 0, dead: 0,
    ...overrides,
  };
  const res = db.prepare(`INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used, cooldown_until, lat_ms, tokens, dead)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.name, row.provider, row.base_url, row.model, row.key_env, row.is_free, row.enabled,
      row.priority, row.weight, row.status, row.ok, row.fail, row.last_used,
      row.cooldown_until, row.lat_ms, row.tokens, row.dead);
  return Number(res.lastInsertRowid);
}

test('scoreRoute belohnt Erfolgsquote und Tempo', () => {
  const fast = scoreRoute({ ok: 95, fail: 5, lat_ms: 200, enabled: 1, dead: 0 });
  const slow = scoreRoute({ ok: 95, fail: 5, lat_ms: 6000, enabled: 1, dead: 0 });
  const flaky = scoreRoute({ ok: 5, fail: 95, lat_ms: 200, enabled: 1, dead: 0 });
  assert.ok(fast > slow, 'schnell muss besser sein als langsam');
  assert.ok(fast > flaky, 'zuverlaessig muss besser sein als unzuverlaessig');
  assert.equal(scoreRoute({ enabled: 0, dead: 1, ok: 50, fail: 0 }), 0, 'tote Route = 0');
});

test('eliteRanking sortiert absteigend und begrenzt Provider-Slots', () => {
  const ids = [
    route({ name: 'A1', provider: 'p1', ok: 100, fail: 0, lat_ms: 150 }),
    route({ name: 'A2', provider: 'p1', ok: 90, fail: 1, lat_ms: 200 }),
    route({ name: 'A3', provider: 'p1', ok: 80, fail: 1, lat_ms: 300 }),
    route({ name: 'A4', provider: 'p1', ok: 70, fail: 1, lat_ms: 400 }),
    route({ name: 'B1', provider: 'p2', ok: 60, fail: 1, lat_ms: 500 }),
  ];
  const elite = eliteRanking({ limit: 5 });
  assert.ok(elite.length <= 5);
  const p1 = elite.filter((r) => r.provider === 'p1');
  assert.ok(p1.length <= 3, 'hoechstens 3 Slots je Provider');
  for (let i = 1; i < elite.length; i += 1) {
    assert.ok(elite[i - 1].score >= elite[i].score, 'absteigend nach Score');
  }
  assert.ok(elite.every((r) => ids.includes(r.id) || r.provider !== 'p1'));
});

test('simulateChain rechnet Ausfallwahrscheinlichkeiten und Latenz', () => {
  const a = route({ name: 'S1', provider: 'p3', ok: 90, fail: 10, lat_ms: 200 });
  const b = route({ name: 'S2', provider: 'p4', ok: 90, fail: 10, lat_ms: 400 });
  const sim = simulateChain([{ routeId: a }, { routeId: b }]);
  assert.equal(sim.steps, 2);
  assert.equal(sim.usable, 2);
  // 1 - (0.1 * 0.1) = 0.99 -> 99 %
  assert.ok(sim.expectedOkPercent >= 98.5 && sim.expectedOkPercent <= 99.5, `erwartet ~99, war ${sim.expectedOkPercent}`);
  assert.equal(sim.expectedLatencyMs, 300);
});

test('simulateChain ueberspringt tote und abgekuehlte Routen', () => {
  const dead = route({ name: 'D1', provider: 'p5', dead: 1, ok: 0, fail: 9 });
  const cooling = route({ name: 'C1', provider: 'p6', cooldown_until: now() + 60000, ok: 9, fail: 1 });
  const sim = simulateChain([{ routeId: dead }, { routeId: cooling }]);
  assert.equal(sim.usable, 0);
  assert.equal(sim.expectedOkPercent, 0);
});

test('simulateChain vertraegt unbekannte Routen-IDs', () => {
  const sim = simulateChain([{ routeId: 999999 }]);
  assert.equal(sim.steps, 1);
  assert.equal(sim.plan[0].missing, true);
  assert.equal(sim.expectedOkPercent, 0);
});

test('saveChain legt an, aktualisiert und protokolliert', () => {
  const a = saveChain({ name: 'Testkette', preset: 'elite', steps: [{ routeId: 1 }, { routeId: 2 }] });
  assert.ok(a.id > 0);
  const b = saveChain({ name: 'Testkette', preset: 'speed', steps: [{ routeId: 3 }], active: true });
  assert.equal(b.id, a.id);
  assert.equal(b.updated, true);
  const list = listChains();
  const chain = list.find((c) => c.name === 'Testkette');
  assert.equal(chain.preset, 'speed');
  assert.equal(chain.steps.length, 1);
  assert.equal(chain.active, true);
});

test('saveChain verlangt einen Namen', () => {
  assert.throws(() => saveChain({ name: '   ' }), /Name fehlt/);
});

test('buildChainFromGoal reagiert auf Tempo und Qualitaet', () => {
  route({ name: 'Q1', provider: 'p7', model: 'oss-120b', ok: 100, fail: 0, lat_ms: 900 });
  route({ name: 'Q2', provider: 'p8', model: 'tiny-3b', ok: 100, fail: 0, lat_ms: 120 });
  const fast = buildChainFromGoal('Baue die schnellste Kette mit 5 Stufen');
  assert.equal(fast.preset, 'speed');
  assert.ok(fast.steps.length > 0 && fast.steps.length <= 20);
  const quality = buildChainFromGoal('Nimm die besten starken Modelle als Elite');
  assert.equal(quality.preset, 'quality');
  assert.ok(quality.rationale.length > 0);
});

test('recordSimulation und studioStatus liefern Kennzahlen', () => {
  const sim = simulateChain([{ routeId: 1 }]);
  recordSimulation(1, sim);
  const status = studioStatus();
  assert.ok(Array.isArray(status.elite));
  assert.ok(status.chains >= 1);
  assert.ok(typeof status.note === 'string' && status.note.length > 0);
});
