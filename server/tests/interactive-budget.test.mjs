import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCascade} from '../llm-cascade.mjs';
test('interactive inference reserves time for a separate local fallback',async()=>{
 let time=1000;const attempts=[];
 const rows=[1,2].map(id=>({id,name:'local-'+id,provider:'ollama',base_url:'http://local-'+id,model:'model',priority:id}));
 const run=createCascade({routes:()=>rows,key:()=>'',freeOnly:()=>false,clock:()=>time,call:async(r,_,opts)=>{
  attempts.push({id:r.id,timeout:opts.timeoutMs});
  if(r.id===1){time+=opts.timeoutMs;throw Object.assign(Error('timeout'),{name:'TimeoutError'});}
  return {content:'actual fallback result'};
 }});
 const out=await run([],{priority:'interactive',totalTimeoutMs:60000});
 assert.equal(out.content,'actual fallback result');assert.deepEqual(attempts.map(x=>x.id),[1,2]);assert.ok(attempts[0].timeout<=30000);assert.ok(attempts[1].timeout>0);assert.equal(run.stats().active,0);
});
