import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deliveryEvidence} from '../delivery-evidence.mjs';

const verified={status:'ready',verification:{ok:true},delivery:'verified-product'};
test('unverified source archive must never obtain verified download',async()=>{
 const r=await deliveryEvidence(42,{readBuild:()=>({status:'unverified',artifact:'villa-42.zip'}),readArtifact:()=>{throw Error('should not access file');}});
 assert.equal(r.downloadAvailable,false);
 assert.equal(r.verified,false);
 assert.deepEqual(r.blockers,['PRODUCT_VERIFICATION_INCOMPLETE']);
 assert.equal(r.artifact,null);
});
test('ready status without runtime verification must remain blocked',async()=>{
 const r=await deliveryEvidence(42,{readBuild:()=>({status:'ready'}),readArtifact:()=>{throw Error('should not access file');}});
 assert.deepEqual(r.blockers,['PRODUCT_VERIFICATION_MISSING']);
});
test('verified artifact has a real computed SHA-256 and download URL',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vf-evidence-'));
 try{
  const file=join(dir,'app.apk'),data=Buffer.from('a real file in a controlled test');
  writeFileSync(file,data);
  const r=await deliveryEvidence(42,{readBuild:()=>verified,readArtifact:()=>({file,name:'app.apk',mime:'application/vnd.android.package-archive'})});
  assert.equal(r.verified,true);
  assert.equal(r.downloadAvailable,true);
  assert.equal(r.artifact.sha256,createHash('sha256').update(data).digest('hex'));
  assert.equal(r.artifact.sizeBytes,data.length);
  assert.equal(r.artifact.url,'/api/villas/42/build/download');
  assert.equal(JSON.stringify(r).includes(dir),false,'Never expose server filesystem paths');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('verified status with missing artifact is blocked',async()=>{
 const r=await deliveryEvidence(42,{readBuild:()=>verified,readArtifact:()=>null});
 assert.deepEqual(r.blockers,['ARTIFACT_MISSING']);
});
test('invalid project ID fails closed',async()=>{
 await assert.rejects(()=>deliveryEvidence(0),/INVALID_VILLA_ID/);
});
