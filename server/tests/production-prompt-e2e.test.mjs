import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireFreeRoutes,validateEvidence,liveProof} from '../../scripts/verify-live-prompt-product.mjs';
test('never start a production job when paid routes are enabled',()=>{
 assert.throws(()=>requireFreeRoutes({freeOnly:false,routes:[{eligible:true,isFree:true}]}),/PAID_ROUTES/);
 assert.throws(()=>requireFreeRoutes({freeOnly:true,routes:[]}),/NO_ELIGIBLE/);
 assert.equal(requireFreeRoutes({freeOnly:true,routes:[{eligible:true,isFree:true}]}),true);
});
test('only real verified artifacts are accepted for release proof',()=>{
 const valid={verified:true,downloadAvailable:true,artifact:{name:'app.zip',url:'/api/villas/8/build/download',sha256:'f'.repeat(64),sizeBytes:200}};
 assert.equal(validateEvidence(valid,8).sizeBytes,200);
 assert.throws(()=>validateEvidence({...valid,verified:false},8),/PRODUCT_NOT_VERIFIED/);
 assert.throws(()=>validateEvidence({...valid,artifact:{...valid.artifact,sha256:'fake'}},8),/INVALID_ARTIFACT_EVIDENCE/);
 assert.throws(()=>validateEvidence(valid,9),/INVALID_ARTIFACT_EVIDENCE/);
});
test('missing credentials fail before any live HTTP request',async()=>{
 const r=await liveProof({email:'',password:'',fetchImpl:()=>{throw Error('unexpected fetch');}});
 assert.equal(r.result,'INCOMPLETE');
 assert.equal(r.phase,'PREFLIGHT');
 assert.deepEqual(r.blockers,['ADMIN_CREDENTIALS_MISSING']);
});
test('live proof stops before project creation when only paid models are available',async()=>{
 let created=false;
 const result=await liveProof({email:'unit@example.test',password:'fixture',fetchImpl:async(url)=>{
  const p=new URL(url).pathname;
  if(p==='/api/health')return new Response(JSON.stringify({ok:true}));
  if(p==='/api/auth/login')return new Response(JSON.stringify({token:'fake-test-token'}));
  if(p==='/api/llm/status')return new Response(JSON.stringify({freeOnly:false,routes:[]}));
  if(p==='/api/deep/projects'){created=true;return new Response('{}');}
  throw Error('Unknown path');
 }});
 assert.equal(created,false);
 assert.deepEqual(result.blockers,['PAID_ROUTES_NOT_DISABLED']);
});
