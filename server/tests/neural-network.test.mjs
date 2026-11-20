import './_env.mjs';
import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {db} from '../db.mjs';
import {activateNeuralNetwork,deactivateNeuralNetwork,neuralNetworkStatus} from '../neural-network.mjs';

beforeEach(()=>{for(const table of ['tasks','agents','villas'])db.prepare(`DELETE FROM ${table}`).run();});
function fixture(status='PAUSED',autonomy=0){
 const id=Number(db.prepare('INSERT INTO villas(name,idea,status,autonomy,max_agents,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('Mesh test','Neural mesh',status,autonomy,20,1,1).lastInsertRowid);
 const root=Number(db.prepare("INSERT INTO agents(villa_id,name,role,status,is_root,parent_id,created_at,last_active_at) VALUES (?,?,?,'IDLE',1,NULL,1,1)").run(id,'DeepAgent','ROOT').lastInsertRowid);
 const planner=Number(db.prepare("INSERT INTO agents(villa_id,name,role,status,is_root,parent_id,created_at,last_active_at) VALUES (?,?,?,'IDLE',0,?,1,1)").run(id,'Planner','PLANNER',root).lastInsertRowid);
 const coder=Number(db.prepare("INSERT INTO agents(villa_id,name,role,status,is_root,parent_id,created_at,last_active_at) VALUES (?,?,?,'IDLE',0,?,1,1)").run(id,'Coder','CODER',root).lastInsertRowid);
 const tester=Number(db.prepare("INSERT INTO agents(villa_id,name,role,status,is_root,parent_id,created_at,last_active_at) VALUES (?,?,?,'IDLE',0,?,1,1)").run(id,'Tester','TESTER',root).lastInsertRowid);
 db.prepare("INSERT INTO tasks(villa_id,agent_id,title,status,priority,created_at,updated_at) VALUES (?,?,?,'PENDING',2,1,1)").run(id,coder,'Build feature');
 db.prepare("INSERT INTO tasks(villa_id,agent_id,title,status,priority,created_at,updated_at) VALUES (?,?,?,'DONE',3,1,1)").run(id,tester,'Test feature');
 return {id,root,planner,coder,tester};
}

test('topology is derived from actual agents, task assignments and parent links',()=>{
 const f=fixture();const s=neuralNetworkStatus(f.id);
 assert.equal(s.network.nodes,4);assert.ok(s.network.edges>=3);
 assert.equal(s.network.topology.communicationEdges,0);
 assert.ok(s.edges.filter(e=>e.kind==='planned_workflow').every(e=>e.label.includes('→')));
 assert.ok(s.edges.filter(e=>e.kind==='supervision').every(e=>e.label==='supervises'));
 assert.equal(s.tasks.PENDING,1);assert.equal(s.tasks.DONE,1);
 assert.ok(s.nodes.find(n=>n.id===f.coder).workload===1);
 assert.equal(s.nodes.find(n=>n.id===f.planner).parentId,f.root);
});

test('activation enables autonomy and dispatches exactly through the existing scheduler',async()=>{
 const f=fixture();let calls=0;
 const s=await activateNeuralNetwork(f.id,{scheduleVilla:(id,opts)=>{calls++;assert.equal(id,f.id);assert.equal(opts.maxRounds,6);return {active:[id],queue:[]};}});
 assert.equal(calls,1);assert.equal(s.accepted,true);assert.equal(s.villa.autonomy,true);
 assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(f.id).autonomy,1);
});

test('scheduler refusal rolls autonomy back',async()=>{
 const f=fixture();await assert.rejects(()=>activateNeuralNetwork(f.id,{scheduleVilla:()=>({refused:true,refusedCode:'SLOT_LIMIT',refusedMessage:'busy'})}),/busy/);
 assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(f.id).autonomy,0);
});

test('deactivation affects only selected Villa and pauses it',()=>{
 const f=fixture('RUNNING',1);let cancelled=0,stopped=0;
 const s=deactivateNeuralNetwork(f.id,{cancelScheduledVilla:()=>{cancelled++;return true;},stopVilla:()=>{stopped++;return true;},isRunning:()=>false});
 assert.equal(cancelled,1);assert.equal(stopped,1);assert.equal(s.villa.autonomy,false);
 assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(f.id).status,'PAUSED');
});

test('archived villas cannot be activated',async()=>{
 const f=fixture('ARCHIVED',0);
 await assert.rejects(()=>activateNeuralNetwork(f.id,{scheduleVilla:()=>({})}),/VILLA_ARCHIVED/);
});
