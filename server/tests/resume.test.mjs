/**
 * Tests fuer die Wiederaufnahme nach Absturz/Neustart (resume.mjs).
 * Szenario: der Prozess stirbt waehrend eines Laufs — die Villa bleibt auf
 * RUNNING stehen. Beim naechsten Start muss sie automatisch weiterlaufen,
 * ausser der Nutzer hat die Autonomie abgeschaltet.
 */
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import { createVilla, orchestrate } from '../agents.mjs';
import { resumePendingVillas } from '../resume.mjs';

async function makeVilla(status, autonomy = 1) {
  seedRoutes();
  const v = await createVilla({ name: 'Resume-Test', idea: 'Eine Testvilla', agentCount: 3 });
  db.prepare('UPDATE villas SET status = ?, autonomy = ?, updated_at = ? WHERE id = ?')
    .run(status, autonomy, now(), v.villaId);
  return { villaId: v.villaId, rootId: v.rootId };
}

function villaStatus(id) {
  return db.prepare('SELECT status FROM villas WHERE id = ?').get(id).status;
}

async function awaitSettled(id, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = villaStatus(id);
    if (s !== 'RUNNING' && s !== 'STOPPING') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Villa ${id} ist nicht fertig geworden`);
}

test('Laufende Villa wird nach Neustart automatisch fortgesetzt', async () => {
  const { villaId } = await makeVilla('RUNNING', 1);
  const result = resumePendingVillas();
  assert.equal(result.resumed, 1);
  assert.deepEqual(result.villas, [villaId]);
  const final = await awaitSettled(villaId);
  assert.ok(['COMPLETED', 'PAUSED', 'FAILED'].includes(final), `unerwarteter Status: ${final}`);
});

test('Autonomie ausgeschaltet: Villa bleibt unberuehrt', async () => {
  const { villaId } = await makeVilla('RUNNING', 0);
  const result = resumePendingVillas();
  assert.equal(result.resumed, 0, 'Villa mit autonomy=0 darf nicht angefasst werden');
  assert.equal(villaStatus(villaId), 'RUNNING', 'Status wurde doch veraendert');
});

test('Andere Status werden nicht angefasst', async () => {
  const a = await makeVilla('PAUSED', 1);
  const b = await makeVilla('COMPLETED', 1);
  const result = resumePendingVillas();
  assert.equal(result.resumed, 0);
  assert.equal(villaStatus(a.villaId), 'PAUSED');
  assert.equal(villaStatus(b.villaId), 'COMPLETED');
});

test('Bereits laufende Villa wird nicht doppelt gestartet', async () => {
  const { villaId } = await makeVilla('RUNNING', 1);
  // Lauf anstossen: orchestrate registriert das Job-Objekt synchron.
  const p = orchestrate(villaId, { adaptive: false });
  const result = resumePendingVillas(); // muss die laufende Villa ueberspringen
  assert.equal(result.resumed, 0, 'laufende Villa wurde erneut angestossen');
  await p;
  await awaitSettled(villaId);
});

test('Ohne unterbrochene Villen: Rueckgabe leer', () => {
  const result = resumePendingVillas();
  assert.equal(result.resumed, 0);
  assert.deepEqual(result.villas, []);
});
