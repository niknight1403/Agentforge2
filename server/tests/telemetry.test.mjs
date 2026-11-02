import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'telemetrie-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { db, now } = await import('../db.mjs');
const {
  buildGreenRate,
  recordBuildResult,
  reworkQuote,
  telemetrySummary,
  timeToFirstWorking,
} = await import('../telemetry.mjs');

function seedVilla(name, createdAt = now()) {
  db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?, 'Idee mit genug Laenge fuer einen Test','CREATED',100,1,?,?)")
    .run(name, createdAt, createdAt);
  return Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
}

function seedTask(villaId, { status = 'DONE', retryCount = 0, assignments = 0 } = {}) {
  const t = now();
  db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, result, created_at, updated_at, retry_count, assignments) VALUES (?,?,?,?,5,\'\',?,?,?,?)')
    .run(villaId, 'Aufgabe', '', status, t, t, retryCount, assignments);
  return Number(db.prepare('SELECT id FROM tasks ORDER BY id DESC LIMIT 1').get().id);
}

test('Ohne Daten sind alle Kennzahlen null statt null Prozent', () => {
  const summary = telemetrySummary();
  assert.equal(summary.buildGreenRate.rate, null);
  assert.equal(summary.buildGreenRate.samples, 0);
  assert.equal(summary.timeToFirstWorking.medianMs, null);
  assert.equal(summary.reworkQuote.quote, null);
  assert.equal(summary.complete, false);
  assert.equal(summary.notes.length, 3);
});

test('build_green_rate zaehlt nur gruene Builds und nennt die Stichprobe', () => {
  const villaId = seedVilla('Build-Villa');
  recordBuildResult({ villaId, status: 'ready', ok: true, startedAt: 1000, finishedAt: 4000 });
  recordBuildResult({ villaId, status: 'unverified', ok: false, startedAt: 5000, finishedAt: 9000, error: 'Abnahme offen' });
  recordBuildResult({ villaId, status: 'failed', ok: false, startedAt: 10_000, finishedAt: 11_000 });
  const rate = buildGreenRate(villaId);
  assert.equal(rate.samples, 3);
  assert.equal(rate.green, 1);
  assert.equal(rate.rate, 33.3);
});

test('Build-Dauer wird aus Start und Ende mitgeschrieben, fehlender Start bleibt null', () => {
  const villaId = seedVilla('Dauer-Villa');
  recordBuildResult({ villaId, status: 'ready', ok: true, startedAt: 2000, finishedAt: 7000 });
  const withStart = db.prepare('SELECT duration_ms FROM build_events WHERE villa_id = ? ORDER BY id DESC LIMIT 1').get(villaId);
  assert.equal(withStart.duration_ms, 5000);
  recordBuildResult({ villaId, status: 'ready', ok: true });
  const withoutStart = db.prepare('SELECT duration_ms FROM build_events WHERE villa_id = ? ORDER BY id DESC LIMIT 1').get(villaId);
  assert.equal(withoutStart.duration_ms, null);
});

test('time_to_first_working misst bis zum ERSTEN gruenen Build einer Villa', () => {
  const base = 1_000_000;
  const villaA = seedVilla('Schnelle Villa', base);
  recordBuildResult({ villaId: villaA, status: 'failed', ok: false, startedAt: base + 100, finishedAt: base + 200 });
  recordBuildResult({ villaId: villaA, status: 'ready', ok: true, startedAt: base + 300, finishedAt: base + 30_000 });
  recordBuildResult({ villaId: villaA, status: 'ready', ok: true, startedAt: base + 31_000, finishedAt: base + 60_000 });

  const single = timeToFirstWorking(villaA);
  assert.equal(single.samples, 1);
  // created_at der Villa war base, der erste gruene Build endete bei base+30_000.
  assert.equal(single.medianMs, 30_000);
  assert.equal(telemetrySummary({ villaId: villaA }).timeToFirstWorking.samples, 1);

  const villaB = seedVilla('Langsame Villa', base);
  recordBuildResult({ villaId: villaB, status: 'ready', ok: true, startedAt: base + 60_000, finishedAt: base + 90_000 });
  const both = timeToFirstWorking();
  assert.equal(both.samples, 2);
  assert.equal(both.fastestMs, 30_000);
  assert.equal(both.slowestMs, 90_000);
});

test('Villen ohne gruenen Build verfaelschen die Kennzahl nicht', () => {
  const villaId = seedVilla('Rote Villa', 5_000_000);
  recordBuildResult({ villaId, status: 'failed', ok: false, startedAt: 5_000_100, finishedAt: 5_000_200 });
  const result = timeToFirstWorking(villaId);
  assert.equal(result.samples, 0);
  assert.equal(result.medianMs, null);
});

test('rework_quote zaehlt Wiederholungen und erneute Zuweisungen', () => {
  const villaId = seedVilla('Nacharbeit-Villa');
  seedTask(villaId, { status: 'DONE' });
  seedTask(villaId, { status: 'DONE', retryCount: 2 });
  seedTask(villaId, { status: 'DONE', assignments: 3 });
  seedTask(villaId, { status: 'FAILED' });
  const quote = reworkQuote(villaId);
  assert.equal(quote.samples, 4);
  assert.equal(quote.reworked, 2);
  assert.equal(quote.quote, 50);
});

test('Kennzahlen lassen sich auf eine Villa eingrenzen', () => {
  const villaA = seedVilla('A-Villa');
  const villaB = seedVilla('B-Villa');
  recordBuildResult({ villaId: villaA, status: 'ready', ok: true, startedAt: 1, finishedAt: 2 });
  recordBuildResult({ villaId: villaB, status: 'failed', ok: false, startedAt: 1, finishedAt: 2 });
  assert.equal(buildGreenRate(villaA).rate, 100);
  assert.equal(buildGreenRate(villaB).rate, 0);
  assert.equal(buildGreenRate().samples > 2, true);
});

test('Unbrauchbare Villa-ID wird abgewiesen statt still zu speichern', () => {
  assert.throws(() => recordBuildResult({ status: 'ready', ok: true }), /villaId/);
  assert.throws(() => recordBuildResult({ villaId: 0, status: 'ready' }), /villaId/);
});

test('Bericht markiert Vollstaendigkeit erst wenn alle drei Kennzahlen Daten haben', () => {
  const villaId = seedVilla('Vollstaendig-Villa', 9_000_000);
  recordBuildResult({ villaId, status: 'ready', ok: true, startedAt: 9_000_100, finishedAt: 9_000_200 });
  seedTask(villaId, { status: 'DONE' });
  const summary = telemetrySummary({ villaId });
  assert.equal(summary.buildGreenRate.samples > 0, true);
  assert.equal(summary.timeToFirstWorking.samples, 1);
  assert.equal(summary.reworkQuote.samples >= 1, true);
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.notes, []);
  assert.equal(summary.scope.villaId, villaId);
});
