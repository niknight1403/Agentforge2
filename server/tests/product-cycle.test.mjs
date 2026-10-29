import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { deliveryPhases } from '../delivery-quality.mjs';
import { developCycle } from '../product.mjs';

function completedCreativeVilla() {
  const id = Number(db.prepare(
    "INSERT INTO villas(name,idea,status,created_at,updated_at) VALUES (?,?,'PAUSED',?,?)"
  ).run('Finite cycle test', 'Erstelle ein professionelles Kampagnenbild', now(), now()).lastInsertRowid);
  const phases = deliveryPhases(id);
  assert.ok(phases?.length, 'creative delivery profile should provide finite phases');
  for (const phase of phases) {
    for (const must of phase.musts) {
      db.prepare(
        'INSERT INTO tasks(villa_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      ).run(id, must.title, must.desc, 'DONE', 5, now(), now());
    }
  }
  return id;
}

test('completion run does not append an unbounded improvement wave', () => {
  const id = completedCreativeVilla();
  const result = developCycle(id, { includeImprovementWave: false });
  assert.equal(result.added, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE villa_id=? AND title LIKE '[WELLE%'").get(id).count, 0);
});

test('background development retains its improvement wave behavior', () => {
  const id = completedCreativeVilla();
  const result = developCycle(id);
  assert.equal(result.added, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE villa_id=? AND title LIKE '[WELLE%'").get(id).count, 3);
});
