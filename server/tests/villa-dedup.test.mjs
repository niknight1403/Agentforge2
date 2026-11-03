import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-dedup-')), 'test.db');
process.chdir(mkdtempSync(join(tmpdir(), 'vf-dedup-cwd-')));

const dbm = await import('../db.mjs');
const agents = await import('../agents.mjs');

agents._setPlanningChat(async () => ({
  content: JSON.stringify({
    summary: 'Test plan',
    tasks: [{ title: 'Implementieren', description: 'Akzeptanz: Tests laufen', role: 'CODER' }]
  })
}));

test('createVilla Namens-Dedup: zweimal "  Test  Villa " liefert dieselbe ID und dedup="reused"', async () => {
  const res1 = await agents.createVilla({ name: '  Test  Villa ', idea: 'Erste Idee' });
  assert.ok(res1.villaId > 0, 'Erste Villa angelegt');
  assert.equal(res1.dedup, undefined);

  const res2 = await agents.createVilla({ name: '  Test  Villa ', idea: 'Zweite Idee' });
  assert.equal(res2.villaId, res1.villaId, 'Zweite Aufruf liefert dieselbe ID');
  assert.equal(res2.dedup, 'reused');
  assert.equal(res2.existingId, res1.villaId);
  assert.equal(res2.existingName, '  Test  Villa ');

  // Pruefe Audit-Eintrag in DB
  const auditRow = dbm.db.prepare('SELECT * FROM audit WHERE villa_id = ? AND tool = ?').get(res1.villaId, 'createVilla');
  assert.ok(auditRow, 'Audit-Eintrag existiert');
  assert.equal(auditRow.result, 'Villa-Name bereits vorhanden - wiederverwendet');
});

test('createVilla mit force=true legt trotz identischem Namen eine neue Villa an', async () => {
  const res1 = dbm.db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get();
  const existingId = res1 ? res1.id : 0;

  const res3 = await agents.createVilla({ name: '  Test  Villa ', idea: 'Dritte Idee mit Force', force: true });
  assert.ok(res3.villaId > existingId, 'Neue Villa-ID erzeugt');
  assert.notEqual(res3.villaId, existingId);
  assert.equal(res3.dedup, undefined);
});
