import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildMeshEvent,startTelemetryConsumer,publishRuntimeCheckpoint} from '../event-mesh.mjs';

test('mesh maps lifecycle events and persists metadata without prompts or tool arguments',()=>{
 const event=buildMeshEvent('task',{status:'RUNNING',taskId:17,agentId:3,title:'private task text',answer:'private output',args:{token:'no'},tool:'code_write'},{id:()=> 'event-1',now:()=>123});
 assert.deepEqual(event,{id:'event-1',type:'agent.step.started',at:123,taskId:17,agentId:3,status:'RUNNING',tool:'code_write'});
 assert.equal(buildMeshEvent('progress',{note:'no stream'}),null);
 assert.equal(buildMeshEvent('task',{status:'PENDING'}).type,'task.created');
});

test('runtime checkpoint bridge sends only the normalized checkpoint with auth',async()=>{
 const oldUrl=process.env.VF_AGENT_RUNTIME_URL,oldToken=process.env.VF_AGENT_RUNTIME_TOKEN,oldFetch=globalThis.fetch;
 let request;
 try{
  process.env.VF_AGENT_RUNTIME_URL='http://runtime:12001';process.env.VF_AGENT_RUNTIME_TOKEN='t'.repeat(40);
  globalThis.fetch=async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return new Response('{}',{status:201});};
  assert.equal(await publishRuntimeCheckpoint({taskId:21,agentId:7,villaId:3,checkpointId:'a'.repeat(64),state:{step:2,lastTool:'code_write'}}),true);
  assert.equal(request.url,'http://runtime:12001/internal/checkpoints');
  assert.equal(request.options.headers.authorization,`Bearer ${'t'.repeat(40)}`);
  assert.deepEqual(request.body.state,{step:2,lastTool:'code_write'});
 }finally{
  globalThis.fetch=oldFetch;
  if(oldUrl===undefined)delete process.env.VF_AGENT_RUNTIME_URL;else process.env.VF_AGENT_RUNTIME_URL=oldUrl;
  if(oldToken===undefined)delete process.env.VF_AGENT_RUNTIME_TOKEN;else process.env.VF_AGENT_RUNTIME_TOKEN=oldToken;
 }
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


test('agent lifecycle emits safe, distinct status metadata',()=>{
 const started=buildMeshEvent('agent',{status:'THINKING',villaId:2,taskId:17,agentId:3,systemPrompt:'private prompt',content:'private output'},{id:()=> 'agent-start',now:()=>124});
 assert.deepEqual(started,{id:'agent-start',type:'agent.started',at:124,villaId:2,taskId:17,agentId:3,status:'THINKING'});
 const idle=buildMeshEvent('agent',{status:'IDLE',villaId:2,taskId:17,agentId:3,code:'QUALITY_GATE'},{id:()=> 'agent-idle',now:()=>125});
 assert.equal(idle.type,'agent.idle');
 assert.equal(buildMeshEvent('agent',{status:'FAILED',agentId:3}).type,'agent.failed');
});


test('agent communication events expose sender and recipient metadata but never message content',()=>{
 const event=buildMeshEvent('agent.message',{villaId:2,agentId:3,toAgentId:4,communicationId:9,taskId:17,status:'SENT',content:'private message'},{id:()=> 'message-1',now:()=>126});
 assert.deepEqual(event,{id:'message-1',type:'agent.message.sent',at:126,villaId:2,taskId:17,agentId:3,toAgentId:4,communicationId:9,status:'SENT'});
});
