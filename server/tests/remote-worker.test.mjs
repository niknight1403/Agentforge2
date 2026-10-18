import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeRemoteWorker} from '../remote-worker.mjs';
const base={VF_REMOTE_WORKER_URL:'https://worker.invalid',VF_REMOTE_WORKER_TOKEN:'fixture-secret'};
test('JSON worker passes scoped payload, bounded deadline and existing credential',async()=>{
 const result=await executeRemoteWorker('embedding',{text:'Test'},{env:base,transport:async(url,opts)=>{
  assert.equal(url.href,'https://worker.invalid/');assert.equal(opts.headers.authorization,'Bearer fixture-secret');assert.equal(opts.redirect,'error');assert.ok(opts.signal instanceof AbortSignal);
  const body=JSON.parse(opts.body);assert.equal(body.task,'embedding');assert.equal(body.input.text,'Test');assert.ok(body.requestId);return Response.json({vector:[1,2]});
 }});assert.deepEqual(result,{vector:[1,2]});
});
test('Gradio streams stop immediately at completion, even when the connection stays open',async()=>{
 let calls=0,cancelled=false;
 const result=await executeRemoteWorker('generate',['idea'],{env:{...base,VF_REMOTE_WORKER_PROTOCOL:'gradio',VF_REMOTE_WORKER_URL:'https://worker.invalid/gradio_api'},transport:async(url,opts)=>{
  calls++;if(calls===1){assert.deepEqual(JSON.parse(opts.body),{data:['idea']});return Response.json({event_id:'event_1'});}
  assert.equal(url,'https://worker.invalid/gradio_api/call/predict/event_1');
  return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: heartbeat\ndata: null\n\nevent: complete\ndata: ["fertig"]\n\n'));},cancel(){cancelled=true;}}));
 }});assert.deepEqual(result,['fertig']);assert.equal(cancelled,true);
});
test('No worker, oversized response and 429 all fail clearly without implicit retry',async()=>{
 await assert.rejects(executeRemoteWorker('x',{}, {env:{}}),/konfiguriert/);
 let calls=0;
 await assert.rejects(executeRemoteWorker('x',{}, {env:base,transport:async()=>{calls++;return new Response('quota',{status:429});}}),/429/);assert.equal(calls,1);
 await assert.rejects(executeRemoteWorker('x',{}, {env:base,transport:async()=>new Response('x'.repeat(1024*1024+1))}),/1 MiB/);
});
test('Busy worker rejects instead of building an unbounded memory queue',async()=>{
 let release;const pending=executeRemoteWorker('x',{}, {env:base,transport:()=>new Promise(r=>{release=()=>r(Response.json({ok:true}));})});
 await assert.rejects(executeRemoteWorker('x',{}, {env:base}),/ausgelastet/);release();await pending;
});
