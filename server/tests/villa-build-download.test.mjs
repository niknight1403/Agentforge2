import {createHash} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchVillaBuild} from '../../scripts/fetch-villa-build.mjs';

async function fixture({status='ready',empty=false,transient=false,tamper=false,unverified=false}={}) {
 let reads=0;const paths=[];const zip=Buffer.alloc(22);zip.writeUInt32LE(0x04034b50);
 const result=await fetchVillaBuild({baseUrl:'https://fixture.example',email:'fixture@example.test',password:'fixture-pass',villaId:1,maxPolls:1,sleep:async()=>{},fetchImpl:async(url,opts)=>{
  const path=new URL(url).pathname;paths.push(path);
  if(path==='/api/auth/login')return new Response(JSON.stringify({token:'fixture-session'}));
  if(path==='/api/villas')return new Response(JSON.stringify([{id:1,name:'Product\nEVIL=value'}]));
  if(path.endsWith('/delivery-evidence'))return new Response(JSON.stringify({verified:!unverified,downloadAvailable:!unverified,artifact:{name:'villa-1.zip',mime:'application/zip',url:'/api/villas/1/build/download',sizeBytes:zip.length,sha256:createHash('sha256').update(tamper?Buffer.from('bad'):zip).digest('hex')}}));
  if(path.endsWith('/download'))return new Response(empty?'<!doctype html>':zip);
  if(transient&&++reads===1)return new Response('down',{status:503});
  return new Response(JSON.stringify({status}));
 }});return {result,paths};
}
test('Villa APK download retries safe reads and sanitizes workflow metadata',async()=>{
 const {result}=await fixture({transient:true});assert.equal(result.bytes.length,22);assert.equal(result.name,'Product EVIL=value');
});
test('Villa APK build fails closed without a real ready ZIP product',async()=>{
 await assert.rejects(fixture({status:'failed'}),/not ready/);await assert.rejects(fixture({empty:true}),/ZIP/);
});
test('Villa APK downloader rejects unsafe origins before sending credentials',async()=>{
 for(const baseUrl of ['http://example.com','https://user:pass@example.com','https://example.com/?token=x'])await assert.rejects(fetchVillaBuild({baseUrl,email:'x',password:'y',villaId:1}));
});

test('APK downloader blocks a product without delivery verification',async()=>{
 await assert.rejects(fixture({unverified:true}),/verified delivery evidence/);
});
test('APK downloader rejects a corrupt artifact against signed-off hash',async()=>{
 await assert.rejects(fixture({tamper:true}),/integrity check failed/);
});
