import './_env.mjs';
import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {db} from '../db.mjs';
import {runTool,dispatchRemoteBatch} from '../agents.mjs';
import {bus} from '../events.mjs';
import {activateNeuralNetwork,deactivateNeuralNetwork,neuralNetworkStatus,sendAgentMessage,readAgentInbox} from '../neural-network.mjs';

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





test('real agent messages are villa-scoped, addressed, durable and visible in topology',()=>{
 const f=fixture();
 const sent=sendAgentMessage(f.id,f.planner,f.coder,'Please implement the agreed interface.');
 assert.equal(sent.fromAgentId,f.planner);assert.equal(sent.toAgentId,f.coder);
 const inbox=readAgentInbox(f.id,f.coder);
 assert.equal(inbox.length,1);assert.equal(inbox[0].content,'Please implement the agreed interface.');
 assert.equal(readAgentInbox(f.id,f.planner).length,0);
 const topology=neuralNetworkStatus(f.id);
 assert.equal(topology.network.topology.communicationEdges,1);
 assert.ok(topology.edges.some(edge=>edge.kind==='communication'&&edge.from===f.planner&&edge.to===f.coder));
 const other=fixture();
 assert.throws(()=>sendAgentMessage(f.id,f.planner,other.coder,'cross-villa'),/PARTICIPANT_NOT_IN_VILLA/);
 assert.throws(()=>sendAgentMessage(f.id,f.planner,f.planner,'self'),/INVALID_PARTICIPANTS/);
});


test('registered agent tools exchange messages through the real tool executor and audit trail',async()=>{
 const f=fixture();
 const events=[];
 const onEvent=event=>{if(event.villaId===f.id)events.push(event);};
 bus.on('event',onEvent);
 try {
  const ctx={villaId:f.id,agentId:f.planner};
  const sent=JSON.parse(await runTool(ctx,'agent_message_send',{
   recipientAgentId:f.coder,
   message:'Implement the agreed API contract before starting the test suite.'
  }));
  assert.equal(sent.fromAgentId,f.planner);
  assert.equal(sent.toAgentId,f.coder);
  const inbox=JSON.parse(await runTool({villaId:f.id,agentId:f.coder},'agent_message_inbox',{limit:5}));
  assert.equal(inbox.length,1);
  assert.equal(inbox[0].content,'Implement the agreed API contract before starting the test suite.');
  assert.ok(events.some(event=>event.type==='agent.message'&&event.communicationId===sent.id));
  const audit=db.prepare('SELECT COUNT(*) AS count FROM audit WHERE villa_id=? AND tool IN (?,?) AND allowed=1').get(f.id,'agent_message_send','agent_message_inbox');
  assert.equal(audit.count,2);
 } finally {
  bus.off('event',onEvent);
 }
});


test('remote dispatch abort after server acceptance never starts a local fallback',async()=>{
 const controller=new AbortController();
 const task={id:901,title:'remote task',retry_count:0};
 let remoteAccepted=false,localRuns=0;
 const cancelled=[];
 const pending=dispatchRemoteBatch({
  batch:[task],villaId:77,job:{controller},runtimeUrl:'https://runtime.invalid',runtimeToken:'test-token',runStart:123,
  executeLocally:async()=>{localRuns++;},onCancelled:async value=>cancelled.push(value.id),timeoutMs:10000,
  fetchImpl:async(_url,options)=>{
   remoteAccepted=true;
   await new Promise((resolve,reject)=>{
    if(options.signal.aborted)return reject(options.signal.reason);
    options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
   });
   return {ok:true};
  }
 });
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(remoteAccepted,true,'remote endpoint accepted the dispatch before response was delayed');
 controller.abort(new Error('Villa stopped'));
 const result=await pending;
 assert.equal(result[0].cancelled,true);
 assert.deepEqual(cancelled,[task.id]);
 assert.equal(localRuns,0,'aborted remote work must not be executed a second time locally');
});
