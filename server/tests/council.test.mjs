/**
 * Tests fuer den Rat der Agenten (v1.11.0).
 *
 * Geprueft: eine Rat-Runde schreibt council-Zeile, COUNCIL-Erinnerung
 * (sichtbar fuer alle Agenten) und COUNCIL-Bericht; listCouncil liefert
 * geparste Strukturen; autoCouncil ueberspringt Villen mit frischer Runde.
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import { createVilla } from '../agents.mjs';
import { runCouncil, listCouncil, autoCouncil } from '../council.mjs';

seedRoutes();

let villaId = 0;

test('Villa fuer Rat-Tests anlegen', async () => {
  const v = await createVilla({ name: 'Rat-Test', idea: 'Selbstoptimierung der Villa', agentCount: 4 });
  villaId = v.villaId;
  assert.ok(villaId > 0);
});

test('runCouncil: Runde, Erinnerung und Bericht schreiben', async () => {
  const mock = async () => ({ answer: 'DEINE ERKENNTNIS: Tests zuerst schreiben.\nVORSCHLAG: Paar-Reviews einfuehren' });
  const out = await runCouncil(villaId, { chatFn: mock, participants: 2 });
  assert.equal(out.round, 1);
  assert.equal(out.proposals, 2);
  assert.equal(out.agents.length, 2);

  const mem = db.prepare("SELECT COUNT(*) c FROM memories WHERE villa_id = ? AND kind = 'COUNCIL'").get(villaId).c;
  assert.equal(mem, 1);
  const memRow = db.prepare("SELECT importance FROM memories WHERE villa_id = ? AND kind = 'COUNCIL'").get(villaId);
  assert.equal(memRow.importance, 8);

  const rep = db.prepare("SELECT COUNT(*) c FROM reports WHERE villa_id = ? AND kind = 'COUNCIL'").get(villaId).c;
  assert.equal(rep, 1);
});

test('listCouncil: geparste Runden mit Vorschlaegen', () => {
  const rows = listCouncil(villaId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].round, 1);
  assert.ok(Array.isArray(rows[0].messages));
  assert.equal(rows[0].proposals.length, 2);
  assert.equal(rows[0].proposals[0].agent, rows[0].messages[0].agent);
});

test('runCouncil: zweite Runde zaehlt hoch', async () => {
  const mock = async () => ({ text: 'Erkenntnis.\nVORSCHLAG: Routen-Prioritaet automatisch justieren' });
  const out = await runCouncil(villaId, { chatFn: mock, participants: 1 });
  assert.equal(out.round, 2);
  assert.equal(out.proposals, 1);
  assert.equal(listCouncil(villaId, 5).length, 2);
});

test('autoCouncil: frische Runde wird uebersprungen', () => {
  const out = autoCouncil({ chatFn: async () => ({ answer: 'x' }) });
  // Die Testvilla hatte gerade Runden — sie darf nicht sofort nachlegen.
  assert.equal(out.considered.includes(villaId), false);
});

test('runCouncil: unbekannte Villa wirkt sauber', async () => {
  await assert.rejects(() => runCouncil(999999, { chatFn: async () => ({ answer: 'x' }) }));
});
