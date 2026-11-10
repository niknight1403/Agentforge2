/**
 * Issue #140: Das Villa-Audit nennt bei roter Produktabnahme nur "noch nicht
 * belegt". Diese Diagnose macht den Grund sichtbar - als stabile Codes, ohne
 * Blockiertexte, Pfade, Prompts oder Villa-Bezug im Protokoll.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-audit-diag-')), 'test.db');
const {
  assessVillaConfiguration,
  productBlockerCode,
  productBlockerCodes,
  aggregateProductBlockers
} = await import('../villa-configuration.mjs');

const villa = { id: 7, idea: 'Ein Dateimanager fuer Android mit Papierkorb und Regeln', status: 'PAUSED', autonomy: 0 };
const agents = [{ id: 1, role: 'ROOT', is_root: 1, system_prompt: 'Goal: x\nConstraints: y\nFormat: z\nFailure Handling: w' }];
const tools = ['project_read', 'project_write', 'project_patch', 'project_run'].map((name) => ({ name, enabled: true }));

function product(blockers) {
  return { verified: false, blockers, readiness: { sourceFiles: 12, checks: {} } };
}

test('jeder bekannte Blockiergrund bekommt einen stabilen Code', () => {
  assert.equal(productBlockerCode('Keine ausführbare Implementierung im Projektordner gefunden'), 'no_implementation');
  assert.equal(productBlockerCode('Prüfnachweis veraltet oder Quellstand geändert'), 'evidence_stale');
  assert.equal(productBlockerCode('Prüfnachweis ungültig'), 'evidence_invalid');
  assert.equal(productBlockerCode('build: kein aktueller erfolgreicher Nachweis'), 'build');
  assert.equal(productBlockerCode('tests: kein aktueller erfolgreicher Nachweis'), 'tests');
  assert.equal(productBlockerCode('smoke: kein aktueller erfolgreicher Nachweis'), 'smoke');
  assert.equal(productBlockerCode('Kein finales Web-Artefakt im Arbeitsbereich gefunden'), 'artifact_missing');
  assert.equal(productBlockerCode('Kein abgeschlossenes Review eines separaten Critic-, Reviewer- oder Tester-Agenten mit dokumentiertem Ergebnis'), 'review_missing');
  assert.equal(productBlockerCode('5 offene Aufgabe(n) verhindern die Abnahme'), 'open_tasks');
  assert.equal(productBlockerCode('2 fehlgeschlagene Aufgabe(n) müssen behoben oder begründet geschlossen werden'), 'failed_tasks');
});

test('unbekannte Gruende fallen auf "other", leere Eingaben ebenfalls', () => {
  assert.equal(productBlockerCode('Ein noch nie gesehener Grund'), 'other');
  assert.equal(productBlockerCode(''), 'other');
  assert.equal(productBlockerCode(undefined), 'other');
  assert.deepEqual(productBlockerCodes(null), []);
});

test('Codes sind sortiert und ohne Doppelungen', () => {
  assert.deepEqual(
    productBlockerCodes(['tests: x', 'build: y', 'tests: z', 'Unbekannt']),
    ['build', 'other', 'tests']
  );
});

test('Bericht nennt Codes statt Blockiertexte', () => {
  const report = assessVillaConfiguration({
    villa,
    agents,
    taskCounts: { DONE: 3, PENDING: 1 },
    tools,
    product: product([
      'Prüfnachweis veraltet oder Quellstand geändert',
      'build: kein aktueller erfolgreicher Nachweis',
      'C:\\Users\\nik\\projekt\\geheim.js ist kaputt'
    ])
  });
  assert.deepEqual(report.productEvidence.blockerCodes, ['build', 'evidence_stale', 'other']);
  assert.equal(report.productEvidence.blockerCount, 3);
  const json = JSON.stringify(report);
  assert.ok(!json.includes('Prüfnachweis'), 'kein Blockiertext im Bericht');
  assert.ok(!json.includes('geheim.js'), 'kein Pfad im Bericht');
  assert.ok(!json.includes('Dateimanager'), 'keine Projektidee im Bericht');
});

test('belegte Abnahme erzeugt keine Blocker-Codes', () => {
  const report = assessVillaConfiguration({
    villa, agents, taskCounts: { DONE: 3 }, tools,
    product: { verified: true, blockers: [], readiness: { sourceFiles: 12, checks: { build: { status: 'passed' } } } }
  });
  assert.deepEqual(report.productEvidence.blockerCodes, []);
});

test('Aggregat zaehlt nur offene Abnahmen, deterministisch sortiert', () => {
  const reports = [
    { productEvidence: { verified: false, blockerCodes: ['build', 'tests'] } },
    { productEvidence: { verified: false, blockerCodes: ['tests', 'evidence_stale'] } },
    { productEvidence: { verified: true, blockerCodes: [] } },
    { productEvidence: { verified: false, blockerCodes: [] } },
    {}
  ];
  assert.deepEqual(aggregateProductBlockers(reports), { build: 1, evidence_stale: 1, tests: 2 });
  assert.deepEqual(aggregateProductBlockers([]), {});
});

test('Audit-Skript meldet das Aggregat und keine Villa-Kennungen im Protokoll', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../scripts/audit-villas.mjs', import.meta.url), 'utf8');
  assert.match(source, /productAcceptanceBlockers:aggregateProductBlockers\(reports\)/);
  assert.match(source, /productAcceptanceBlockers:report\.productAcceptanceBlockers/);
  const logLine = source.slice(source.indexOf('console.log(JSON.stringify({source'));
  assert.ok(!/villas:report\.villas/.test(logLine), 'Protokoll enthaelt keine Villa-Liste');
  assert.ok(!/'\/api\/villas\/'\+id\+'\/product'[\s\S]*console\.log/.test(logLine));
});
