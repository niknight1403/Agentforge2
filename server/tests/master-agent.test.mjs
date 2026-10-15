import './_env.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { duplicateSummary, removeDuplicates } from '../villa-dedupe.mjs';
import { villaSuggestions } from '../suggestions.mjs';
import { masterChat, masterState } from '../master-agent.mjs';

let first;
let duplicate;
function insertVilla(name, idea) {
  return Number(db.prepare('INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(name, idea, 'RUNNING', 1000, 1, now(), now()).lastInsertRowid);
}

before(() => {
  first = insertVilla('Master Demo', 'Eine App für strukturierte Vorschläge');
  duplicate = insertVilla('Master Demo', 'Eine App für strukturierte Vorschläge');
  db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(first, 'Ersten Vorschlag prüfen', 'Prüfung', 'PENDING', 1, now(), now());
});

test('Duplikat-Erkennung liefert Vorschau ohne zu löschen', () => {
  const summary = duplicateSummary();
  const group = summary.groups.find((g) => g.duplicates.some((v) => v.id === duplicate));
  assert.ok(group);
  assert.equal(group.keep.id, first);
  assert.equal(summary.duplicateCount, 1);
  assert.ok(db.prepare('SELECT id FROM villas WHERE id = ?').get(duplicate));
});

test('Duplikat-Bereinigung akzeptiert nur bestätigte Kandidaten', () => {
  const dry = removeDuplicates([first], { isRunning: () => false });
  assert.equal(dry.applied.length, 0);
  const done = removeDuplicates([duplicate], { isRunning: () => false });
  assert.equal(done.applied.length, 1);
  assert.equal(db.prepare('SELECT id FROM villas WHERE id = ?').get(duplicate), undefined);
});

test('Vorschläge sind aus dem Villa-Zustand abgeleitet', () => {
  const suggestions = villaSuggestions(first);
  assert.ok(suggestions.some((s) => s.id === 'next-task'));
  assert.ok(suggestions.every((s) => s.prompt && s.rationale));
});

test('Master-Agent liefert Status und protokolliert Verlauf', async () => {
  const out = await masterChat('Status und aktive Konfiguration anzeigen');
  assert.equal(out.ok, true);
  assert.equal(out.action, 'state.inspect');
  assert.equal(out.state.villas.length, 1);
  assert.ok(masterState().connectors.length >= 1);
});
