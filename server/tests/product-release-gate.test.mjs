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
 assert.equal(inspectProductZip(zip()).entries,1);assert.throws(()=>inspectProductZip(Buffer.from('PK-not-an-archive')),/INVALID/);
 assert.throws(()=>inspectProductZip(zip('README.md')),/FILES_MISSING/);assert.throws(()=>inspectProductZip(zip('../index.html')),/UNSAFE/);
});
test('Release acceptance requires independent product evidence, zero open work, ready build and actual download',async()=>{
 let downloaded=0;const run=(product,build='ready')=>verifyProductAcceptance({requestJson:async path=>path==='/api/villas'?[{id:1}]:path.endsWith('/product')?product:{status:build},download:async()=>{downloaded++;return zip();}});
 const accepted={verified:true,unfinishedTasks:0,blockers:[]};assert.equal((await run(accepted)).villaId,1);assert.equal(downloaded,1);
 for(const p of [{...accepted,verified:false},{...accepted,unfinishedTasks:1},{...accepted,blockers:['missing source']}])await assert.rejects(run(p),/ACCEPTANCE_MISSING/);
 await assert.rejects(run(accepted,'unverified'),/ACCEPTANCE_MISSING/);assert.equal(downloaded,1);
});
