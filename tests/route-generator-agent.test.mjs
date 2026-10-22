import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverConfiguredRoutes,probeConfiguredRoutes} from '../server/route-generator-agent.mjs';
test('only configured endpoints discovered',()=>{
 const routes=discoverConfiguredRoutes({VF_LLM_ORACLE_URL:'https://oracle.example.com/v1',VF_LLM_ORACLE_MODEL:'qwen',VF_LLM_HETZNER_URL:'http://remote.example.com/v1'});
 assert.equal(routes.length,1);assert.equal(routes[0].model,'qwen');
});
test('reject URLs containing embedded credentials',()=>{
 assert.deepEqual(discoverConfiguredRoutes({VF_LLM_ORACLE_URL:'https://username:secret@example.com/v1'}),[]);
});
test('probe errors are reported as unhealthy',async()=>{
 const r=await probeConfiguredRoutes({env:{VF_LLM_ORACLE_URL:'https://oracle.example.com/v1'},fetcher:async()=>{throw Error('offline')}});
 assert.equal(r[0].reachable,false);
});
test('reachable local model server',async()=>{
 const r=await probeConfiguredRoutes({env:{VF_LOCAL_LLM_URL:'http://127.0.0.1:11434/v1'},fetcher:async()=>({ok:true,status:200})});
 assert.equal(r[0].reachable,true);
});
