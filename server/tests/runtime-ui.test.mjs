import {test} from 'node:test';
import assert from 'node:assert/strict';
await import('../public/runtime-ui.js');
const {summarizeHealth,chooseVilla}=globalThis.VFRuntimeUI;
test('Hub availability, eligible routes and model evidence are distinct states',()=>{
 assert.equal(summarizeHealth({ok:true,llm:{eligibleRoutes:5}}).state,'unverified');
 assert.equal(summarizeHealth({ok:true,llm:{eligibleRoutes:0}}).state,'blocked');
 assert.equal(summarizeHealth({error:'HTTP 503'}).state,'offline');
 assert.equal(summarizeHealth({ok:true,llm:{queue:{active:1,waiting:2}}}).state,'busy');
 assert.equal(summarizeHealth({ok:true,llm:{eligibleRoutes:1,lastSuccessfulReplyAt:1000}},2000).state,'ready');
 assert.equal(summarizeHealth({ok:true,llm:{eligibleRoutes:1,lastSuccessfulReplyAt:1000}},400000).state,'unverified');
 assert.equal(summarizeHealth({ok:true,llm:{eligibleRoutes:1,lastSuccessfulReplyAt:5000}},2000).state,'unverified');
});
test('Selected cockpit project remains selected while other villas run',()=>{
 const villas=[{id:1,status:'RUNNING'},{id:2,status:'PAUSED'}];
 assert.equal(chooseVilla(villas,2,1).id,2);assert.equal(chooseVilla(villas,99,1).id,1);
 assert.equal(chooseVilla([],2,1),null);
});
