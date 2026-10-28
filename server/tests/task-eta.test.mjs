import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTaskEta, MAX_ETA_MINUTES } from '../task-eta.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'task-eta-'));
process.env.VF_DB = join(tmp, 'test.db');
const { db } = await import('../db.mjs');

test('ETA basiert auf Ausführungszeiten statt auf Alter geplanter Aufgaben', () => {
  const result = estimateTaskEta(6, [60_000, 120_000, 180_000], 3);
  assert.equal(result.etaMin, 4);
  assert.equal(result.etaCapped, false);
  assert.equal(result.sampleCount, 3);
});

test('fehlende oder ungültige Messwerte fallen auf eine kurze, begrenzte Basis zurück', () => {
  assert.deepEqual(estimateTaskEta(3, [0, -10, Number.NaN], 3), { etaMin: 2, etaCapped: false, sampleCount: 0 });
});

test('Ausreißer und unrealistische Alt-Laufzeiten verfälschen den Median nicht', () => {
  const result = estimateTaskEta(3, [60_000, 120_000, 10 * 24 * 60 * 60 * 1000], 3);
  assert.equal(result.etaMin, 2);
  assert.equal(result.sampleCount, 2);
});

test('extreme Warteschlangen werden als >24h statt als Hunderttausende Minuten angezeigt', () => {
  const result = estimateTaskEta(1_000_000, [], 3);
  assert.equal(result.etaMin, MAX_ETA_MINUTES);
  assert.equal(result.etaCapped, true);
});

test('ohne offene Aufgaben gibt es keine Restzeit', () => {
  assert.deepEqual(estimateTaskEta(0, [120_000], 2), { etaMin: 0, etaCapped: false, sampleCount: 0 });
});

test('bestehende Datenbanken erhalten Startzeit und Ausführungsdauer idempotent', () => {
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
  assert.ok(columns.includes('started_at'));
  assert.ok(columns.includes('duration_ms'));
  assert.equal(db.prepare("SELECT started_at,duration_ms FROM tasks LIMIT 1").get(), undefined);
});
