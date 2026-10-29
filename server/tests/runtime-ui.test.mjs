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

test('Historical route successes do not override a cooldown or open circuit',()=>{
 const route={enabled:1,ok:100,fail:1};
 assert.equal(globalThis.VFRuntimeUI.routePresentation(route,{configured:true,eligible:true,status:'OK',cooldownUntil:3000},1000).eligible,false);
 const circuit=globalThis.VFRuntimeUI.routePresentation(route,{configured:true,eligible:false,status:'OK',circuit:{state:'OPEN',retryAt:3000}},1000);
 assert.match(circuit.label,/Schutzpause/);assert.equal(circuit.tone,'new');
 assert.equal(globalThis.VFRuntimeUI.routePresentation(route,{configured:false},1000).label,'Zugang fehlt');
 assert.equal(globalThis.VFRuntimeUI.routePresentation(route,{configured:true,eligible:true,status:'ERROR'},1000).label,'Freigegeben · ungeprüft');
});
