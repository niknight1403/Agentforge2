import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readLedger,completeSprint} from '../../scripts/sprint-ledger.mjs';
test('Sprint ledger recovers progress from its authoritative backlog after an interrupted state write',()=>{
 const root=mkdtempSync(join(tmpdir(),'vf-ledger-'));mkdirSync(join(root,'docs/sprints/evidence'),{recursive:true});
 const backlog={schemaVersion:1,sprints:Array.from({length:500},(_,i)=>({id:'VF-'+String(i+1).padStart(4,'0'),scopeDefined:i===0,goal:i===0?'Fixture acceptance':null,acceptanceCriteria:i===0?['verified']:[],status:i===0?'planned':'unscoped',dependencies:[],evidence:[],implementationCommit:null}))};
 const save=(name,value)=>writeFileSync(join(root,'docs/sprints',name+'.json'),JSON.stringify(value));
 try{
  save('backlog',backlog);save('state',{schemaVersion:1,current:'VF-0001',next:'VF-0001',completed:[]});
  writeFileSync(join(root,'docs/sprints/evidence/fixture.json'),JSON.stringify({exitCode:0,acceptanceComplete:true}));
  completeSprint({root,id:'VF-0001',commit:'a'.repeat(40),evidencePath:'docs/sprints/evidence/fixture.json'});
  save('state',{schemaVersion:1,current:'VF-0001',next:'VF-0001',completed:[]});
  const recovered=readLedger(root).state;assert.deepEqual(recovered.completed,['VF-0001']);assert.equal(recovered.next,'VF-0002');assert.equal(recovered.current,null);
  assert.throws(()=>completeSprint({root,id:'VF-0002',commit:'a'.repeat(40),evidencePath:'docs/sprints/evidence/fixture.json'}),/scope/);
  const broken=JSON.parse(readFileSync(join(root,'docs/sprints/backlog.json')));broken.sprints[499].id='VF-9999';save('backlog',broken);assert.throws(()=>readLedger(root),/ordered/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
