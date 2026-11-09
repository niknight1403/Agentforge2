/**
 * Fertigstellungs-Bericht: Blocker werden belegt benannt, nichts wird
 * faelschlich als fertig bezeichnet.
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveViewState, summarizeReadiness } from '../deep-completion.mjs';

const readyGate = { ready: true, checks: {}, blockers: [] };
const blockedGate = {
  ready: false,
  checks: {},
  blockers: [
    { label: 'Build-Nachweis fehlt', detail: 'kein Build-Log' },
    { label: 'Tests fehlen', detail: 'kein Testlauf' }
  ]
};
const readyHandover = { ready: true, checks: {}, blockers: [] };
const blockedHandover = {
  ready: false,
  checks: {},
  blockers: [{ label: 'TASTE fehlt', detail: 'taste.json fehlt' }]
};

test('nichts fehlt: Bericht ist fertig und nennt den Startschritt', () => {
  const report = summarizeReadiness({
    projectId: 7,
    gate: readyGate,
    handover: readyHandover,
    villa: { id: 12, name: 'Deep · Test', status: 'RUNNING' },
    live: { available: true, entry: 'index.html', detail: 'ok' }
  });
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.liveViewAvailable, true);
  assert.match(report.note, /Alle belegten Pruefungen/);
});

test('fehlender Produktnachweis erzeugt Produkt-Blocker und passende naechste Aktion', () => {
  const report = summarizeReadiness({
    projectId: 8,
    gate: blockedGate,
    handover: blockedHandover,
    villa: null,
    live: { available: false, entry: null, detail: 'kein index.html' }
  });
  assert.equal(report.ready, false);
  assert.equal(report.blockers.filter((entry) => entry.area === 'produkt').length, 2);
  assert.equal(report.blockers.some((entry) => entry.area === 'uebergabe'), true);
  assert.equal(report.blockers.some((entry) => entry.area === 'villa'), true);
  assert.equal(report.blockers.some((entry) => entry.area === 'live'), true);
  assert.equal(report.nextActions.length >= 3, true);
  assert.match(report.note, /Nicht fertig/);
});

test('Gates erfuellt, aber keine Villa: naechster Schritt ist der Entwicklungsstart', () => {
  const report = summarizeReadiness({
    projectId: 9,
    gate: readyGate,
    handover: readyHandover,
    villa: null,
    live: { available: true, entry: 'index.html', detail: 'ok' }
  });
  assert.equal(report.ready, false);
  assert.equal(report.villaLinked, false);
  assert.match(report.nextActions.join(' '), /Entwicklung starten/);
});

test('fehlender Vorschau-Einstiegspunkt wird als Live-Blocker gemeldet', () => {
  const report = summarizeReadiness({
    projectId: 10,
    gate: readyGate,
    handover: readyHandover,
    villa: { id: 1 },
    live: { available: false, entry: null, detail: 'kein index.html' }
  });
  assert.equal(report.ready, false);
  assert.equal(report.liveViewAvailable, false);
  assert.match(report.nextActions.join(' '), /Web-Build/);
});

test('liveViewState meldet ohne Projektordner ehrlich fehlende Auslieferbarkeit', () => {
  const state = liveViewState(987654);
  assert.equal(state.available, false);
  assert.equal(state.entry, null);
  assert.match(state.detail, /Kein Einstiegspunkt/);
});
