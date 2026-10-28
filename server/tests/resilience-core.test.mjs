import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { saveCheckpoint,recoverCheckpoint } from '../checkpoints.mjs';
import { createCircuitBreaker } from '../circuit-breaker.mjs';
import { runSupervisedTask } from '../supervisor.mjs';

test('checkpoints are atomic hash-linked recovery records and reject sensitive fields',()=>{
 db.prepare('DELETE FROM agent_checkpoints WHERE task_id=?').run(90001);
 const a=saveCheckpoint({taskId:90001,agentId:77,state:{cursor:1,files:['src/app.js']}});
 const b=saveCheckpoint({taskId:90001,agentId:77,state:{cursor:2,files:['src/app.js','test.js']}});
 assert.equal(b.parentId,a.checkpointId);assert.equal(b.sequence,2);
 assert.deepEqual(recoverCheckpoint(90001,77).state,{cursor:2,files:['src/app.js','test.js']});
 assert.throws(()=>saveCheckpoint({taskId:90001,agentId:77,state:{accessToken:'must-not-persist'}}),/sensitive field/);
});

test('circuit breaker opens deterministically, admits one recovery probe, then closes',async()=>{
 let now=1000;const breaker=createCircuitBreaker({failureThreshold:2,resetAfterMs:100,clock:()=>now});
 const failed=async()=>{throw Object.assign(new Error('provider down'),{status:503});};
 await assert.rejects(breaker.execute('provider-a',failed));await assert.rejects(breaker.execute('provider-a',failed));
 assert.equal(breaker.snapshot('provider-a').state,'OPEN');
 await assert.rejects(breaker.execute('provider-a',async()=>1),e=>e.code==='CIRCUIT_OPEN');
 now+=101;assert.equal(await breaker.execute('provider-a',async()=>42),42);
 assert.equal(breaker.snapshot('provider-a').state,'CLOSED');
});

test('supervisor checkpoints progress, repairs validation failures and detects repeated calls',async()=>{
 db.prepare('DELETE FROM agent_checkpoints WHERE task_id IN (?,?)').run(90002,90003);
 const events=[];let calls=0;
 const ok=await runSupervisedTask({taskId:90002,agentId:77,initialState:{done:false},maxSteps:4,step:async({state,promptHint})=>{
   calls++;if(calls===1)return {state:{done:false,count:1},toolCall:{name:'write_file',args:{path:'a'}}};
   assert.match(promptHint,/Validation failed/);return {state:{done:true,count:2},done:true,completed:['a']};
  },validate:(_,state)=>state.done?{ok:true}:{ok:false,errors:['first criterion pending']},onEvent:e=>events.push(e)});
 assert.equal(ok.status,'completed');assert.equal(recoverCheckpoint(90002,77).state.state.count,2);
 assert.ok(events.some(e=>e.type==='checkpoint.saved'));
 const loop=await runSupervisedTask({taskId:90003,agentId:77,initialState:{v:1},maxSteps:8,step:async()=>({state:{v:1},toolCall:{name:'same_tool',args:{x:1}}})});
 assert.equal(loop.status,'loop_detected');assert.equal(loop.steps,3);
});
