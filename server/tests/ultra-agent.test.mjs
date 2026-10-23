import './_env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { CAPABILITIES, QUALITY_GATE, createUltraAgent, evaluateNextAction, recordLesson, ultraStatus } from '../ultra-agent.mjs';

beforeEach(()=>{
  for(const t of ['ultra_lessons','ultra_state','tasks','agents','memories','villas']) db.prepare(`DELETE FROM ${t}`).run();
});
function makeVilla(){
  return Number(db.prepare('INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('Test Villa','Produkt bauen','PAUSED',0,1,1).lastInsertRowid);
}
function task(id,status){db.prepare('INSERT INTO tasks(villa_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,status,status,1,1);}

test('Ultra-Agent exponiert Capability Registry und sichere Security-Grenze',()=>{
  const security=CAPABILITIES.find(c=>c.id==='security');
  assert.ok(CAPABILITIES.length>=15);assert.match(security.note,/autorisiert/i);assert.ok(security.level<=2);
});

test('Autopilot aktiviert Villa, waehlt Arbeit und startet idempotent',async()=>{
  const id=makeVilla();task(id,'PENDING');let starts=0,running=false;
  const ultra=createUltraAgent({isRunning:()=>running,startVilla:async()=>{starts++;running=true;return {started:id};}});
  ultra.setEnabled(id,true);
  const out=await ultra.tick(id);
  assert.equal(out.decision.action,'EXECUTE');assert.equal(out.started,true);assert.equal(starts,1);
  const again=await ultra.tick(id);assert.equal(again.started,false);assert.equal(starts,1);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(id).autonomy,1);
});

test('Fehler priorisieren Heilung und Lessons bleiben persistent',()=>{
  const id=makeVilla();task(id,'FAILED');
  const ultra=createUltraAgent();ultra.setEnabled(id,true);
  assert.equal(evaluateNextAction(id).action,'HEAL');
  recordLesson(id,{content:'Timeout braucht Failover',score:90});
  assert.equal(ultraStatus(id).lessons,1);
});

test('Quality Gate verlangt verifizierten Fortschritt statt Selbstaussage',()=>{
  const id=makeVilla();task(id,'DONE');
  const ultra=createUltraAgent();ultra.setEnabled(id,true);
  const s=ultraStatus(id);
  assert.equal(s.qualityGate,QUALITY_GATE);assert.equal(s.gatePassed,true);
  assert.equal(evaluateNextAction(id).action,'VERIFY_RELEASE');
});

test('Deaktivieren stoppt nur laufende eigene Villa und nimmt Autonomie weg',()=>{
  const id=makeVilla();let stopped=0;
  const ultra=createUltraAgent({isRunning:x=>x===id,stopVilla:()=>{stopped++;return true;}});
  ultra.setEnabled(id,true);ultra.setEnabled(id,false);
  assert.equal(stopped,1);assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(id).autonomy,0);
});
