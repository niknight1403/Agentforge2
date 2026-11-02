import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  countAcceptanceCriteria,
  evaluateProductGate,
  productGateForProjectDir,
  scanProjectEvidence,
} from '../deep-product-gate.mjs';

const VERIFIED = {
  build: { status: 'passed' },
  tests: { status: 'passed' },
  userFlow: { status: 'passed' },
};

function productFiles(overrides = {}) {
  const base = [
    { path: 'src/app.mjs', content: 'export const start = () => "ok";' },
    { path: 'src/rechnung.mjs', content: 'export const summe = (a, b) => a + b;' },
    { path: 'docs/spec.md', content: '# Spezifikation\n' + 'Nutzer legt Rechnungen an und exportiert sie als CSV. '.repeat(6) },
    { path: 'acceptance.json', content: JSON.stringify({ criteria: ['Rechnung anlegen', 'CSV exportieren'] }) },
    { path: 'tests/app.test.mjs', content: 'test("start", () => {});' },
    { path: 'README.md', content: '# Produkt\n\nStart: npm start\n' },
  ];
  // Bewusst 'in'-Pruefung: verification:null muss ein fehlender Beleg bleiben.
  return {
    files: overrides.files ?? base,
    verification: Object.prototype.hasOwnProperty.call(overrides, 'verification') ? overrides.verification : VERIFIED,
  };
}

test('Ein leeres Projekt besteht das Gate nicht und nennt die fehlenden Belege', () => {
  const gate = evaluateProductGate({ files: [] });
  assert.equal(gate.ready, false);
  const keys = gate.blockers.map((b) => b.key);
  assert.ok(keys.includes('source'));
  assert.ok(keys.includes('spec'));
  assert.ok(keys.includes('tests'));
  assert.ok(keys.includes('verification'));
  assert.equal(gate.checks.secrets.status, 'passed');
});

test('Belegtes Produkt mit Spec, Kriterien, Tests und Verifikation besteht das Gate', () => {
  const gate = evaluateProductGate(productFiles());
  assert.equal(gate.ready, true, JSON.stringify(gate.blockers));
  assert.equal(gate.checks.start.evidence, 'npm start');
  assert.equal(gate.checks.tests.status, 'passed');
});

test('Fehlender Verifikationslauf blockiert, statt optimistisch durchzuwinken', () => {
  const gate = evaluateProductGate(productFiles({ verification: null }));
  assert.equal(gate.ready, false);
  assert.equal(gate.checks.verification.status, 'unknown');
  assert.ok(gate.blockers.some((b) => b.key === 'verification'));
});

test('Ein fehlgeschlagener Build bleibt ein Blocker', () => {
  const gate = evaluateProductGate(productFiles({ verification: { build: { status: 'failed' }, tests: { status: 'passed' }, userFlow: { status: 'passed' } } }));
  assert.equal(gate.ready, false);
  assert.equal(gate.checks.verification.status, 'failed');
});

test('Ein Test ohne echte Testdatei zaehlt nicht als Testbeleg', () => {
  const files = productFiles().files.filter((f) => !f.path.includes('test'));
  const gate = evaluateProductGate({ files, verification: VERIFIED });
  assert.equal(gate.ready, false);
  assert.ok(gate.blockers.some((b) => b.key === 'tests'));
});

test('Secrets im Projekt blockieren die Villa-Uebergabe', () => {
  const files = productFiles().files.concat([{ path: 'src/config.mjs', content: 'const key = "sk_live_51Habcdefghijklmnop";' }]);
  const gate = evaluateProductGate({ files, verification: VERIFIED });
  assert.equal(gate.ready, false);
  assert.equal(gate.checks.secrets.status, 'failed');
  assert.match(gate.checks.secrets.evidence, /src\/config\.mjs/);
});

test('Spezifikation muss inhaltlich gefuellt sein, ein Dateiname genuegt nicht', () => {
  const files = productFiles().files.map((f) => (f.path === 'docs/spec.md' ? { ...f, content: '# Spec' } : f));
  const gate = evaluateProductGate({ files, verification: VERIFIED });
  assert.equal(gate.ready, false);
  assert.ok(gate.blockers.some((b) => b.key === 'spec'));
});

test('Abnahmekriterien werden als JSON und als Checkboxen erkannt', () => {
  assert.equal(countAcceptanceCriteria(JSON.stringify(['a', 'b'])), 2);
  assert.equal(countAcceptanceCriteria(JSON.stringify({ criteria: ['a', 'b', 'c'] })), 3);
  assert.equal(countAcceptanceCriteria('- [x] anlegen\n- [ ] exportieren\n'), 2);
  assert.equal(countAcceptanceCriteria('kein Inhalt'), 0);
});

test('Scanner ignoriert node_modules und liefert relative Pfade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-gate-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {};');
    writeFileSync(join(dir, 'node_modules', 'lib', 'index.mjs'), 'module.exports={};');
    const scan = scanProjectEvidence(dir);
    assert.equal(scan.missing, false);
    assert.deepEqual(scan.files.map((f) => f.path), [join('src', 'app.mjs')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fehlender Projektordner blockiert mit eigenem Grund', () => {
  const gate = productGateForProjectDir(join(tmpdir(), 'vf-gate-gibt-es-nicht'));
  assert.equal(gate.ready, false);
  assert.equal(gate.blockers[0].key, 'evidence');
});
