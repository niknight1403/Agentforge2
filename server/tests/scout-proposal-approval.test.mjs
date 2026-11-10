import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-proposal-')), 'test.db');
const { db, now } = await import('../db.mjs');
const { approveProposal } = await import('../scout.mjs');

test('approved project proposal persists the created villaId, without a duplicate', async () => {
  const id = Number(db.prepare("INSERT INTO proposals(title, proposed_name, masterprompt, agent_count, status, created_at, project_type, classification_reason) VALUES (?,?,?,?,?,?,?,?)")
    .run('Improvement', 'Target Project', 'Build a project', 4, 'pending', now(), 'NEW_PROJECT', 'Eigenstaendiges neues Projekt ohne Zielrepository.').lastInsertRowid);
  let calls = 0;
  const result = await approveProposal(id, async () => { calls++; return { villaId: 42, rootId: 9 }; });
  assert.deepEqual(result, { villaId: 42, villaName: 'Target Project' });
  const stored = db.prepare('SELECT status, villa_id FROM proposals WHERE id=?').get(id);
  assert.equal(stored.status, 'approved');
  assert.equal(stored.villa_id, 42);
  await assert.rejects(() => approveProposal(id, async () => { calls++; }), /nicht \(mehr\) offen/);
  assert.equal(calls, 1);
});
test('missing created villaId restores pending proposal for retry', async () => {
  const id = Number(db.prepare("INSERT INTO proposals(title, masterprompt, status, created_at, project_type, classification_reason) VALUES (?,?,?,?,?,?)")
    .run('Bad', 'Prompt', 'pending', now(), 'NEW_PROJECT', 'Eigenstaendiges neues Projekt ohne Zielrepository.').lastInsertRowid);
  await assert.rejects(() => approveProposal(id, async () => ({})), /Villa-ID/);
  assert.equal(db.prepare('SELECT status FROM proposals WHERE id=?').get(id).status, 'pending');
});
