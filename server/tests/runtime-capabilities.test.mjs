import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeCapabilityInventory,cachedRuntimeCapabilityInventory,resetRuntimeCapabilityInventoryCacheForTest} from '../runtime-capabilities.mjs';
test('runtime inventory executes only bounded allowlisted version probes',()=>{
 const calls=[];
 const results=runtimeCapabilityInventory({run:(command,args,options)=>{
  calls.push({command,args,options});
  return {status:0,stdout:'version 1.0\\n',stderr:''};
 }});
 assert.ok(results.some(r=>r.id==='ffmpeg'&&r.status==='available'));
 assert.ok(results.some(r=>r.id==='flutter'&&r.status==='available'));
 assert.ok(calls.every(c=>c.options.shell===false&&c.options.timeout<=2000));
 assert.ok(calls.every(c=>c.args.length>0));
});
test('missing binary is unavailable, never claimed verified',()=>{
 const results=runtimeCapabilityInventory({run:()=>({error:{code:'ENOENT'},status:null})});
 assert.ok(results.every(r=>r.status==='unavailable'));
});
test('failed version probe is not available',()=>{
 const results=runtimeCapabilityInventory({run:()=>({status:1,stderr:'failed'})});
 assert.ok(results.every(r=>r.status==='unavailable'));
});


test('runtime capability inventory caches probes for one minute and refreshes after TTL', () => {
 resetRuntimeCapabilityInventoryCacheForTest();
 let clock = 1000;
 let calls = 0;
 const run = () => { calls += 1; return {status: 0, stdout: 'version 1.0\\n', stderr: ''}; };
 const first = cachedRuntimeCapabilityInventory({run, now: () => clock});
 const second = cachedRuntimeCapabilityInventory({run, now: () => clock});
 assert.deepEqual(second, first);
 assert.equal(calls, first.length);
 clock += 60_001;
 const third = cachedRuntimeCapabilityInventory({run, now: () => clock});
 assert.deepEqual(third, first);
 assert.equal(calls, first.length * 2);
 resetRuntimeCapabilityInventoryCacheForTest();
});
