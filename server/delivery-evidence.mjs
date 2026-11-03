/**
 * Verifiable delivery certificate. A source archive or an unverified build
 * is never treated as a finished product. The public response contains no
 * internal absolute paths, secrets or invented URLs.
 */
import {createHash} from 'node:crypto';
import {createReadStream,statSync} from 'node:fs';
import {buildArtifact,buildStatus} from './builds.mjs';

export async function deliveryEvidence(villaId,{readBuild=buildStatus,readArtifact=buildArtifact,stat=statSync,stream=createReadStream}={}){
 const id=Number(villaId);
 if(!Number.isSafeInteger(id)||id<=0)throw Error('INVALID_VILLA_ID');
 const record=readBuild(id);
 const result={villaId:id,buildStatus:record.status||'none',verified:false,downloadAvailable:false,blockers:[],artifact:null};
 if(record.status!=='ready'){
  result.blockers.push(record.status==='unverified'?'PRODUCT_VERIFICATION_INCOMPLETE':'NO_VERIFIED_BUILD');
  return result;
 }
 if(record.verification?.ok!==true||record.delivery!=='verified-product'){
  result.blockers.push('PRODUCT_VERIFICATION_MISSING');
  return result;
 }
 const artifact=readArtifact(id);
 if(!artifact){
  result.blockers.push('ARTIFACT_MISSING');
  return result;
 }
 try{
  const meta=stat(artifact.file);
  if(!meta.isFile()||meta.size<=0||meta.size>1024*1024*1024){
   result.blockers.push('ARTIFACT_INVALID_SIZE');
   return result;
  }
  const hash=createHash('sha256');
  let bytes=0;
  for await(const chunk of stream(artifact.file)){
   bytes+=chunk.length;
   if(bytes>1024*1024*1024)throw Error('ARTIFACT_SIZE_LIMIT');
   hash.update(chunk);
  }
  if(bytes!==meta.size)throw Error('ARTIFACT_CHANGED_DURING_READ');
  result.verified=true;
  result.downloadAvailable=true;
  result.artifact={name:artifact.name,mime:artifact.mime,sizeBytes:bytes,sha256:hash.digest('hex'),url:`/api/villas/${id}/build/download`};
  return result;
 }catch{
  result.blockers.push('ARTIFACT_READ_OR_INTEGRITY_FAILED');
  return result;
 }
}
