import './_env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { createMasterControl, validateAction } from '../master-control.mjs';
import { packState, setPackEnabled } from '../packs.mjs';

beforeEach(()=>{for(const t of ['ultra_lessons','ultra_state','control_messages','control_turns','tasks','agents','memories','villas']) db.prepare(`DELETE FROM ${t}`).run();});
function makeVilla(){return Number(db.prepare('INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('APEX Test','Build','PAUSED',0,1,1).lastInsertRowid);}
function service(runningRef={value:false}){
 return createMasterControl({
  chat:async()=>({offline:true}),createVilla:async()=>({villaId:makeVilla()}),
  isRunning:()=>runningRef.value,stopVilla:()=>{runningRef.value=false;return true;},
  cancelScheduledVilla:()=>false,startVilla:async id=>{runningRef.value=true;return {started:id};},
  packState,setPackEnabled,toolSpecs:()=>[],emit:()=>{}
 });
}
test('Master validiert Ultra-Aktionen mit Villa-ID',()=>{
 const id=makeVilla();
 assert.deepEqual(validateAction({type:'ultra_status',args:{villaId:id}}),{type:'ultra_status',args:{villaId:id}});
 assert.throws(()=>validateAction({type:'ultra_tick',args:{villaId:0}}),/ungültig/);
});
test('Direkter Autopilot-Befehl aktiviert und startet APEX Omega',async()=>{
 const id=makeVilla(), s=service();
 const out=await s.turn({message:`Aktiviere Autopilot #${id}`,requestId:'ultra-start-1234'});
 assert.equal(out.ok,true);assert.equal(out.steps[0].type,'ultra_enable');assert.equal(out.steps[1].type,'ultra_tick');
 assert.equal(db.prepare('SELECT enabled FROM ultra_state WHERE villa_id=?').get(id).enabled,1);
 assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(id).autonomy,1);
});
test('Master-Status meldet APEX Omega Capability Registry',()=>{
 const id=makeVilla(), s=service();s.status();
 const state=s.status();assert.ok(state.ultra.capabilities>=15);assert.deepEqual(state.ultra.enabledVillas,[]);
});
