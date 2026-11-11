import {test} from 'node:test';import assert from 'node:assert/strict';
import {inspectProductZip,isValidDeliverableArtifact,verifyProductAcceptance} from '../../scripts/lib/product-release-gate.mjs';
function zip(names=['index.html']){
 const entries=names.map(name=>({name,data:Buffer.from(name==='mimetype'?'application/epub+zip':name.endsWith('.xml')?'<root/>':'<main>Fixture app</main>')}));
 const locals=[],centrals=[];let offset=0;
 for(const entry of entries){
  const n=Buffer.from(entry.name),data=entry.data;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
  locals.push(local,n,data);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);
  centrals.push(central,n);offset+=local.length+n.length+data.length;
 }
 const centralSize=centrals.reduce((sum,b)=>sum+b.length,0);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,...centrals,end]);
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
test('Release acceptance validates document/data files instead of treating them as ZIPs or playable media',async()=>{
 const csv=Buffer.from('name,value\nalpha,12\nbeta,25\n');
 assert.equal(isValidDeliverableArtifact(csv,'.csv'),true);
 assert.equal(isValidDeliverableArtifact(Buffer.alloc(32),'.csv'),false);
 const result=await verifyProductAcceptance({
  requestJson:async path=>path==='/api/villas'?[{id:2}]:path.endsWith('/product')
   ?{verified:true,blockers:[]}:{status:'ready',artifact:'villa-2.csv',artifactType:'deliverable'},
  download:async()=>csv
 });
 assert.deepEqual(result.deliverable,{extension:'.csv',bytes:csv.length});
});


test('declared document, archive, CAD, firmware and media formats validate by content', () => {
 for (const extension of ['.ods', '.key', '.3mf', '.zip']) {
  assert.equal(isValidDeliverableArtifact(zip(), extension), true, extension);
 }
 assert.equal(isValidDeliverableArtifact(Buffer.from('{\\rtf1\\ansi A valid rich text document body}'), '.rtf'), true);
 const tiff = Buffer.alloc(1024);
 tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
 assert.equal(isValidDeliverableArtifact(tiff, '.tif'), true);
 assert.equal(isValidDeliverableArtifact(tiff, '.tiff'), true);
 const aac = Buffer.alloc(1024);
 aac.set([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);
 assert.equal(isValidDeliverableArtifact(aac, '.aac'), true);
 assert.equal(isValidDeliverableArtifact(Buffer.from('void setup() { pinMode(13, OUTPUT); } // firmware'), '.ino'), true);
});
