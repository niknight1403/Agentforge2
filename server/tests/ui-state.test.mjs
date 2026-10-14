import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/ui-state.js';
const { visibleVillas } = globalThis.VillaUI;
const data = Object.freeze([
  Object.freeze({ id: 1, name: 'Äpfel', idea: 'Musik Studio', status: 'PAUSED' }),
  Object.freeze({ id: 3, name: 'Projekt 10', idea: 'Audio', status: 'RUNNING' }),
  Object.freeze({ id: 2, name: 'Projekt 2', idea: 'App', status: 'RUNNING' })
]);
test('Suche kombiniert Name, Idee und Status ohne den Snapshot zu verändern', () => {
  assert.deepEqual(visibleVillas(data, { query: '  MUSIK ' }).map(v => v.id), [1]);
  assert.deepEqual(visibleVillas(data, { query: 'projekt', status: 'RUNNING' }).map(v => v.id), [3, 2]);
  assert.deepEqual(visibleVillas(data, { query: 'audio', status: 'PAUSED' }), []);
  assert.deepEqual(data.map(v => v.id), [1, 3, 2]);
});
test('Sortierung ist natürlich und deterministisch', () => {
  assert.deepEqual(visibleVillas(data, { sort: 'name' }).map(v => v.id), [1, 2, 3]);
  assert.deepEqual(visibleVillas(data, { sort: 'status' }).map(v => v.id), [1, 3, 2]);
  assert.deepEqual(visibleVillas(data).map(v => v.id), [3, 2, 1]);
});
test('Leere Listen und optionale Beschreibungen sind gültig', () => {
  assert.deepEqual(visibleVillas([], { query: 'x' }), []);
  assert.deepEqual(visibleVillas([{ id: 4 }], { query: 'x' }), []);
});
