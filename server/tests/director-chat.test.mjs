/**
 * Regie-Chat: Anweisungen werden erkannt, gespeichert und erst nach
 * nachweislicher Uebernahme als angewandt markiert.
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { createPersona } from '../persona-packs.mjs';
import {
  DIRECTION_KINDS,
  activeDirections,
  classifyDirection,
  consumeDirections,
  directorHistory,
  directorStatus,
  postInstruction
} from '../director-chat.mjs';

function seedVilla(name = 'Regie-Villa') {
  const ts = Date.now();
  const info = db.prepare('INSERT INTO villas(name,idea,status,max_agents,autonomy,route_strategy,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, 'Test-Idee', 'CREATED', 3, 1, 'ROTATE', ts, ts);
  return Number(info.lastInsertRowid);
}

test('Stichworte werden den richtigen Anweisungsarten zugeordnet', () => {
  const cases = [
    ['Zieh das Business-Pack an', 'outfit'],
    ['Szene: Kueche am Morgen, Kamera nah', 'scene'],
    ['Spiel ruhiger und waermer', 'tone'],
    ['Morgen um 9 drehen', 'schedule'],
    ['Stopp, bitte pausieren', 'pause'],
    ['Weiter bitte', 'resume'],
    ['Trag keine auffaelligen Farben', 'no_go'],
    ['Halte eine Kaffeetasse', 'prop']
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyDirection(text).kind, expected, text);
  }
  assert.equal(classifyDirection('').kind, null);
  assert.equal(classifyDirection('Danke, das war alles').kind, null);
});

test('Anweisung wird gespeichert, gilt aber nicht sofort als angewandt', () => {
  const villaId = seedVilla();
  const result = postInstruction(villaId, null, 'Zieh das Abend-Pack an');
  assert.equal(result.recorded, true);
  assert.equal(result.applied, false);
  assert.equal(result.direction.kind, 'outfit');
  assert.equal(result.direction.status, 'offen');
  assert.match(result.note, /naechsten Produktionslauf/);
});

test('Nachricht ohne Stichwort wird ehrlich als nicht ausfuehrbar gemeldet', () => {
  const villaId = seedVilla('Chat-Villa');
  const result = postInstruction(villaId, null, 'Danke dir');
  assert.equal(result.recorded, true);
  assert.equal(result.direction, null);
  assert.match(result.note, /keine ausfuehrbare Anweisung/);
  assert.equal(activeDirections(villaId).length, 0);
});

test('Leere Anweisung und falsche Villa-IDs werden abgelehnt', () => {
  const villaId = seedVilla('Fehler-Villa');
  assert.throws(() => postInstruction(villaId, null, '   '), /ANWEISUNG_LEER/);
  assert.throws(() => postInstruction(0, null, 'Szene: Test'), /VILLA_ID_INVALID/);
  assert.throws(() => postInstruction(villaId, -3, 'Szene: Test'), /PERSONA_ID_INVALID/);
});

test('Anweisungen werden erst beim Abholen angewandt, und nur fuer verarbeitete Arten', () => {
  const villaId = seedVilla('Uebernahme-Villa');
  postInstruction(villaId, null, 'Zieh das Studio-Pack an');
  postInstruction(villaId, null, 'Morgen um 8 drehen');

  const partial = consumeDirections(villaId, null, ['outfit']);
  assert.equal(partial.applied.length, 1);
  assert.equal(partial.applied[0].kind, 'outfit');

  const rest = activeDirections(villaId);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].kind, 'schedule');

  const second = consumeDirections(villaId, null, ['schedule']);
  assert.equal(second.applied.length, 1);
  assert.equal(activeDirections(villaId).length, 0);
});

test('Abholen ohne gueltige Art aendert nichts', () => {
  const villaId = seedVilla('Arten-Villa');
  postInstruction(villaId, null, 'Szene: Balkon');
  const result = consumeDirections(villaId, null, ['unfug']);
  assert.equal(result.skipped, 'keine_gueltige_art');
  assert.equal(activeDirections(villaId).length, 1);
});

test('Verlauf und Status zaehlen offen und angewandt', () => {
  const villaId = seedVilla('Status-Villa');
  postInstruction(villaId, null, 'Szene: Dachterrasse');
  postInstruction(villaId, null, 'Spiel energiegeladener');
  consumeDirections(villaId, null, ['scene']);

  const status = directorStatus(villaId);
  assert.equal(status.open, 1);
  assert.equal(status.applied, 1);
  assert.equal(status.byKind.scene, 1);
  assert.equal(status.byKind.tone, 1);

  const history = directorHistory(villaId, null, 10);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
});

test('Anweisungen einer Figur erreichen nur diese Figur', () => {
  const villaId = seedVilla('Personen-Villa');
  const personaId = createPersona(villaId, { name: 'Mara' }).id;

  postInstruction(villaId, personaId, 'Zieh das Abend-Pack an');
  assert.equal(activeDirections(villaId, personaId).length, 1);
  assert.equal(activeDirections(villaId, personaId + 999).length, 0);
  for (const kind of DIRECTION_KINDS) assert.equal(typeof kind, 'string');
});
