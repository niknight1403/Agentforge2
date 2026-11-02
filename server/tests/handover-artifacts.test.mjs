import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateHandoverArtifacts,
  evaluateTasteArtifact,
  evaluateSpionArtifact,
  parseArtifact,
  scanHandoverArtifacts,
  TASTE_MIN_STATEMENTS,
  SPION_MIN_COMPETITORS
} from '../handover-artifacts.mjs';

const TODAY = new Date('2026-11-02T12:00:00Z');

const taste = (overrides = {}) => ({
  statements: [
    { claim: 'Niko will reine Entwicklungsarbeit ohne Marketingpflicht', evidence: { source: 'repo:cybersarah/commits' } },
    { claim: 'Niko zahlt nur fuer belegten Nutzen, nicht fuer Reichweite', evidence: { source: 'https://github.com/niknight1403/CyberSarah-Control-Center' } },
    { claim: 'Niko bevorzugt Android-Apps mit sofort nutzbarem Build', evidence: { source: 'feedback:apk-installation' } }
  ],
  ...overrides
});

const spion = (overrides = {}) => ({
  competitors: [
    {
      name: 'Lovable',
      observation: 'Veroeffentlicht Web-Apps direkt nach dem Chat, ohne lokale Umgebung.',
      source: 'https://lovable.dev',
      date: '2026-10-20'
    },
    {
      name: 'Bolt',
      observation: 'Baut im Browser und exportiert das Projekt als ZIP fuer den eigenen Rechner.',
      source: 'https://bolt.new',
      date: '2026-10-25'
    }
  ],
  ...overrides
});

test('leere Uebergabe blockiert und nennt beide Artefakte', () => {
  const report = evaluateHandoverArtifacts({ today: TODAY });
  assert.equal(report.ready, false);
  assert.deepEqual(report.blockers.map((b) => b.key).sort(), ['spion', 'taste']);
});

test('belegte Artefakte passieren das Gate', () => {
  const report = evaluateHandoverArtifacts({ taste: taste(), spion: spion(), today: TODAY });
  assert.equal(report.ready, true);
  assert.equal(report.checks.taste.status, 'passed');
  assert.equal(report.checks.spion.status, 'passed');
  assert.equal(report.blockers.length, 0);
});

test('Markdown zaehlt nicht als Beleg', () => {
  assert.equal(parseArtifact('# Praeferenzen\n- mag Android'), null);
  const report = evaluateHandoverArtifacts({ taste: '# Profil', spion: 'frei text', today: TODAY });
  assert.equal(report.ready, false);
});

test('zu wenige TASTE-Aussagen blockieren', () => {
  const report = evaluateTasteArtifact({ statements: [taste().statements[0]] });
  assert.equal(report.status, 'failed');
  assert.match(report.evidence, new RegExp(`mindestens ${TASTE_MIN_STATEMENTS}`));
});

test('TASTE-Aussage ohne Quelle blockiert und nennt den Index', () => {
  const report = evaluateTasteArtifact({
    statements: [
      { claim: 'Niko will reine Entwicklungsarbeit ohne Marketingpflicht', evidence: {} },
      { claim: 'Niko bevorzugt Android-Apps mit sofort nutzbarem Build', evidence: { source: 'feedback:apk' } },
      { claim: 'Niko mag kurze Release-Zyklen mit sichtbarem Ergebnis', evidence: { source: 'repo:releases' } }
    ]
  });
  assert.equal(report.status, 'failed');
  assert.match(report.evidence, /ohne brauchbare Quelle: 0/);
});

test('TASTE-Aussage ohne Inhalt blockiert', () => {
  const report = evaluateTasteArtifact({
    statements: [
      { claim: 'zu kurz', evidence: { source: 'feedback:x' } },
      { claim: 'Niko bevorzugt Android-Apps mit sofort nutzbarem Build', evidence: { source: 'feedback:apk' } },
      { claim: 'Niko mag kurze Release-Zyklen mit sichtbarem Ergebnis', evidence: { source: 'repo:releases' } }
    ]
  });
  assert.equal(report.status, 'failed');
  assert.match(report.evidence, /ohne ausreichenden Inhalt: 0/);
});

test('SPION ohne Quelle, ohne Datum und mit Zukunftsdatum blockiert', () => {
  const noSource = evaluateSpionArtifact({
    competitors: [
      { name: 'A', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'interner Zettel', date: '2026-10-20' },
      { name: 'B', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'https://b.example', date: '2026-10-20' }
    ]
  }, TODAY);
  assert.equal(noSource.status, 'failed');
  assert.match(noSource.evidence, /keine oeffentliche Quelle/);

  const noDate = evaluateSpionArtifact({
    competitors: [
      { name: 'A', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'https://a.example' },
      { name: 'B', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'https://b.example', date: '2026-10-20' }
    ]
  }, TODAY);
  assert.match(noDate.evidence, /Datum fehlt/);

  const future = evaluateSpionArtifact(spion({ competitors: [
    { name: 'A', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'https://a.example', date: '2027-01-01' },
    { name: 'B', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'https://b.example', date: '2026-10-20' }
  ] }), TODAY);
  assert.equal(future.status, 'failed');
  assert.match(future.evidence, /Zukunft/);
});

test('SPION mit lokaler Adresse als Quelle blockiert', () => {
  const report = evaluateSpionArtifact(spion({ competitors: [
    { name: 'A', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'http://localhost:3000', date: '2026-10-20' },
    { name: 'B', observation: 'Baut Web-Apps direkt im Browser ohne lokale Installation.', source: 'https://b.example', date: '2026-10-20' }
  ] }), TODAY);
  assert.equal(report.status, 'failed');
});

test('zu wenige Wettbewerber blockieren', () => {
  const report = evaluateSpionArtifact(spion({ competitors: [spion().competitors[0]] }), TODAY);
  assert.equal(report.status, 'failed');
  assert.match(report.evidence, new RegExp(`mindestens ${SPION_MIN_COMPETITORS}`));
});

test('Secrets in Artefakten blockieren die Uebergabe', () => {
  const report = evaluateHandoverArtifacts({
    taste: taste(),
    spion: spion({ note: 'api key sk_live_ABCDEFGHIJKLMNOP fuer Testzwecke' }),
    today: TODAY
  });
  assert.equal(report.ready, false);
  assert.equal(report.checks.secrets.status, 'failed');
  assert.deepEqual(report.blockers.map((b) => b.key), ['secrets']);
});

test('scanHandoverArtifacts liest JSON-Dateien aus dem Projektordner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-'));
  writeFileSync(join(dir, 'taste.json'), JSON.stringify(taste()));
  writeFileSync(join(dir, 'spion.json'), JSON.stringify(spion()));
  const report = scanHandoverArtifacts(dir, { today: TODAY });
  assert.equal(report.ready, true);
  assert.deepEqual(report.files, { taste: true, spion: true });
});

test('scanHandoverArtifacts blockiert bei fehlendem Ordner', () => {
  const report = scanHandoverArtifacts(join(tmpdir(), 'gibt-es-nicht-' + Date.now()), { today: TODAY });
  assert.equal(report.ready, false);
  assert.deepEqual(report.files, { taste: false, spion: false });
});
