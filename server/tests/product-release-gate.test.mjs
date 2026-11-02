import {test} from 'node:test';import assert from 'node:assert/strict';
import {inspectProductZip,verifyProductAcceptance} from '../../scripts/lib/product-release-gate.mjs';
function zip(name='index.html'){
 const n=Buffer.from(name),data=Buffer.from('<main>Fixture app</main>');
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
 const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50);header.writeUInt32LE(data.length,20);header.writeUInt32LE(data.length,24);header.writeUInt16LE(n.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(header.length+n.length,12);end.writeUInt32LE(local.length+n.length+data.length,16);
 return Buffer.concat([local,n,data,header,n,end]);
}
test('Product archive requires a complete app archive instead of PK bytes or an empty package',()=>{
 assert.equal(inspectProductZip(zip()).entries,1);const bad=zip();bad.writeUInt32LE(999999,30+Buffer.byteLength('index.html')+Buffer.byteLength('<main>Fixture app</main>')+20);assert.throws(()=>inspectProductZip(bad),/INVALID/);assert.throws(()=>inspectProductZip(Buffer.from('PK-not-an-archive')),/INVALID/);
 assert.throws(()=>inspectProductZip(zip('README.md')),/FILES_MISSING/);assert.throws(()=>inspectProductZip(zip('../index.html')),/UNSAFE/);
});
test('Release acceptance requires product evidence, no blockers, ready build and actual download',async()=>{
 let downloaded=0;const run=(product,build='ready')=>verifyProductAcceptance({requestJson:async path=>path==='/api/villas'?[{id:1}]:path.endsWith('/product')?product:{status:build},download:async()=>{downloaded++;return zip();}});
 const accepted={verified:true,unfinishedTasks:0,blockers:[]};assert.equal((await run(accepted)).villaId,1);assert.equal(downloaded,1);
 // Ein offener Ausbau-Backlog ist kein Release-Blocker: die Autonomie legt
 // laufend Aufgaben an, sonst gaebe es nie ein Release.
 assert.equal((await run({...accepted,unfinishedTasks:81})).villaId,1);
 for(const p of [{...accepted,verified:false},{...accepted,blockers:['missing source']}])await assert.rejects(run(p),/ACCEPTANCE_MISSING/);
 await assert.rejects(run(accepted,'unverified'),/ACCEPTANCE_MISSING/);assert.equal(downloaded,2);
});

test('Failure diagnosis reports every selected Villa without exposing names, blocker text, or secrets',async()=>{
 const villas=Array.from({length:18},(_,i)=>({id:i+1,tasks_done:i<10?100-i:0,name:`Private Villa ${i+1}`}));
 const requested=[];
 let failure;
 try{
  await verifyProductAcceptance({
   requestJson:async path=>{
    requested.push(path);
    if(path==='/api/villas')return villas;
    if(path.endsWith('/product'))return {verified:false,blockers:['GITHUB_TOKEN=fixture-value customer@example.test','Smoke verification missing']};
    if(path.endsWith('/build'))return {status:'ready'};
    throw Error(`Unexpected request ${path}`);
   },
   download:async()=>{throw Error('must not download an unverified product');}
  });
 }catch(error){failure=error;}
 assert.ok(failure instanceof Error);
 const prefix='PRODUCT_ACCEPTANCE_MISSING: ';
 assert.ok(failure.message.startsWith(prefix),failure.message);
 const summary=JSON.parse(failure.message.slice(prefix.length));
 assert.equal(summary.apiListShape,'array');
 assert.equal(summary.listedVillas,18);
 assert.equal(summary.paginationMetadataPresent,false);
 assert.equal(summary.validVillaIds,18);
 assert.equal(summary.selectedCandidates,10);
 assert.equal(summary.candidateLimit,10);
 assert.equal(summary.candidatesOmitted,8);
 assert.equal(summary.selectionOrder,'tasks_done_desc_then_response_order');
 assert.deepEqual(summary.checked.map(x=>x.id),Array.from({length:10},(_,i)=>i+1));
 assert.ok(summary.checked.every(x=>x.product==='not_verified'&&x.blockerCount===2&&x.build==='ready'));
 assert.deepEqual(summary.checked[0].blockerCategories,{other:1,tests_or_smoke:1});
 assert.equal(requested.filter(path=>path.endsWith('/product')).length,10);
 assert.equal(requested.filter(path=>path.endsWith('/build')).length,10);
 assert.doesNotMatch(failure.message,/fixture-value|customer@example\.test|Private Villa/);
});

test('Failure diagnosis flags pagination metadata rather than implying the response is complete',async()=>{
 let failure;
 try{
  await verifyProductAcceptance({
   requestJson:async path=>path==='/api/villas'?{villas:[{id:1}],total:18,limit:1,offset:0}:{verified:false,blockers:[]},
   download:async()=>Buffer.alloc(0)
  });
 }catch(error){failure=error;}
 assert.ok(failure instanceof Error);
 const summary=JSON.parse(failure.message.slice(failure.message.indexOf('{')));
 assert.equal(summary.paginationMetadataPresent,true);
 assert.equal(summary.listedVillas,1);
 assert.equal(summary.selectedCandidates,1);
});

test('Failure diagnosis distinguishes blocker, non-ready build, and endpoint HTTP failures by Villa',async()=>{
 let failure;
 try{
  await verifyProductAcceptance({
   requestJson:async path=>{
    if(path==='/api/villas')return [{id:1},{id:2},{id:3},{id:4}];
    if(path.endsWith('/1/product'))return {verified:false,blockers:['Source project missing']};
    if(path.endsWith('/1/build'))return {status:'failed'};
    if(path.endsWith('/2/product'))return {verified:true,blockers:[]};
    if(path.endsWith('/2/build'))return {status:'pending'};
    if(path.endsWith('/3/product'))throw Error(`${path} HTTP 503 token=never-log`);
    if(path.endsWith('/4/product'))return {verified:true,blockers:[]};
    if(path.endsWith('/4/build'))throw Error(`${path} HTTP 404 token=never-log`);
    throw Error(`Unexpected request ${path}`);
   },
   download:async()=>Buffer.alloc(0)
  });
 }catch(error){failure=error;}
 assert.ok(failure instanceof Error);
 const summary=JSON.parse(failure.message.slice(failure.message.indexOf('{')));
 assert.deepEqual(summary.checked.map(x=>[x.id,x.product,x.build]),[
  [1,'not_verified','failed'],
  [2,'verified','pending'],
  [3,'request_failed_http_503','not_checked'],
  [4,'verified','request_failed_http_404']
 ]);
 assert.doesNotMatch(failure.message,/never-log/);
});

test('Diagnosis records ZIP download failures and continues to another eligible Villa',async()=>{
 const result=await verifyProductAcceptance({
  requestJson:async path=>path==='/api/villas'?[{id:1},{id:2}]:path.endsWith('/product')?{verified:true,blockers:[]}: {status:'ready'},
  download:async path=>{if(path.includes('/1/'))throw Error('PRODUCT_DOWNLOAD_HTTP_503 token=never-log');return zip();}
 });
 assert.equal(result.villaId,2);
});

test('Failed ZIP candidate is included in safe diagnosis when no later candidate passes',async()=>{
 let failure;
 try{
  await verifyProductAcceptance({
   requestJson:async path=>path==='/api/villas'?[{id:1},{id:2}]:path.endsWith('/product')?{verified:true,blockers:[]}: {status:'ready'},
   download:async path=>{if(path.includes('/1/'))throw Error('PRODUCT_DOWNLOAD_HTTP_503 token=never-log');return Buffer.from('not a zip');}
  });
 }catch(error){failure=error;}
 assert.ok(failure instanceof Error);
 const summary=JSON.parse(failure.message.slice(failure.message.indexOf('{')));
 assert.deepEqual(summary.checked.map(x=>x.download),['failed_product_download_http_503','failed_product_archive_invalid']);
 assert.doesNotMatch(failure.message,/never-log/);
});
