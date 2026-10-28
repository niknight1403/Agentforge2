import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildMeshEvent,startTelemetryConsumer} from '../event-mesh.mjs';

test('mesh maps lifecycle events and persists metadata without prompts or tool arguments',()=>{
 const event=buildMeshEvent('task',{status:'RUNNING',taskId:17,agentId:3,title:'private task text',answer:'private output',args:{token:'no'},tool:'code_write'},{id:()=> 'event-1',now:()=>123});
 assert.deepEqual(event,{id:'event-1',type:'agent.step.started',at:123,taskId:17,agentId:3,status:'RUNNING',tool:'code_write'});
 assert.equal(buildMeshEvent('progress',{note:'no stream'}),null);
 assert.equal(buildMeshEvent('task',{status:'PENDING'}).type,'task.created');
});

test('telemetry consumer stays disabled until endpoint and token are configured', async()=>{
 const oldUrl=process.env.CYBERSARAH_TELEMETRY_URL,oldToken=process.env.CYBERSARAH_TELEMETRY_TOKEN;
 try {
  delete process.env.CYBERSARAH_TELEMETRY_URL; delete process.env.CYBERSARAH_TELEMETRY_TOKEN;
  const out=await startTelemetryConsumer();
  assert.equal(out.ok,false); assert.equal(out.reason,'telemetry_not_configured');
 } finally {
  if(oldUrl===undefined)delete process.env.CYBERSARAH_TELEMETRY_URL;else process.env.CYBERSARAH_TELEMETRY_URL=oldUrl;
  if(oldToken===undefined)delete process.env.CYBERSARAH_TELEMETRY_TOKEN;else process.env.CYBERSARAH_TELEMETRY_TOKEN=oldToken;
 }
});
