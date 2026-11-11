/** Real product acceptance is independent of model and hub availability. */
import {isPlayableArtifact} from '../../server/media-artifact.mjs';
export function inspectProductZip(bytes){
 const b=Buffer.from(bytes);if(b.length<22||b.readUInt32LE(0)!==0x04034b50)throw Error('PRODUCT_ARCHIVE_INVALID');
 let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
 if(end<0)throw Error('PRODUCT_ARCHIVE_INVALID');
 const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
 if(!count||count>20000||offset+size>end||b.readUInt16LE(end+4)||b.readUInt16LE(end+6))throw Error('PRODUCT_ARCHIVE_INVALID');
 let cursor=offset;const names=[];
 for(let n=0;n<count;n++){
  if(cursor+46>offset+size||b.readUInt32LE(cursor)!==0x02014b50)throw Error('PRODUCT_ARCHIVE_INVALID');
  const len=b.readUInt16LE(cursor+28),extra=b.readUInt16LE(cursor+30),comment=b.readUInt16LE(cursor+32),next=cursor+46+len+extra+comment;
  if(next>offset+size)throw Error('PRODUCT_ARCHIVE_INVALID');const name=b.subarray(cursor+46,cursor+46+len).toString('utf8');
  if(name.startsWith('/')||name.split(/[\\/]/).includes('..'))throw Error('PRODUCT_ARCHIVE_UNSAFE');
  const localOffset=b.readUInt32LE(cursor+42),packed=b.readUInt32LE(cursor+20),unpacked=b.readUInt32LE(cursor+24);
  if(localOffset+30>offset||b.readUInt32LE(localOffset)!==0x04034b50||b.readUInt16LE(cursor+8)&1)throw Error('PRODUCT_ARCHIVE_INVALID');
  const localLen=b.readUInt16LE(localOffset+26),localExtra=b.readUInt16LE(localOffset+28),payload=localOffset+30+localLen+localExtra;
  if(payload+packed>offset||b.subarray(localOffset+30,localOffset+30+localLen).toString('utf8')!==name)throw Error('PRODUCT_ARCHIVE_INVALID');
  if(unpacked>0&&packed>0)names.push(name);cursor=next;
 }
 if(cursor!==offset+size||!names.some(n=>/(?:^|\/)(?:index\.html|package\.json|AndroidManifest\.xml)$/.test(n)))throw Error('PRODUCT_APP_FILES_MISSING');
 return {entries:count,bytes:b.length};
}
function zipEntryNames(bytes) {
 const b=Buffer.from(bytes||[]);
 if(b.length<22||b.readUInt32LE(0)!==0x04034b50)return null;
 let end=-1;
 for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){
  if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
 }
 if(end<0)return null;
 const disk=b.readUInt16LE(end+4),centralDisk=b.readUInt16LE(end+6);
 const diskCount=b.readUInt16LE(end+8),count=b.readUInt16LE(end+10);
 const size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
 if(disk||centralDisk||diskCount!==count||!count||count>20000||offset+size!==end)return null;
 let cursor=offset;const names=[];
 for(let n=0;n<count;n++){
  if(cursor+46> end||b.readUInt32LE(cursor)!==0x02014b50)return null;
  const flags=b.readUInt16LE(cursor+8),method=b.readUInt16LE(cursor+10);
  const packed=b.readUInt32LE(cursor+20),unpacked=b.readUInt32LE(cursor+24);
  const nameLen=b.readUInt16LE(cursor+28),extraLen=b.readUInt16LE(cursor+30),commentLen=b.readUInt16LE(cursor+32);
  const next=cursor+46+nameLen+extraLen+commentLen;
  if(next>end||flags&1||![0,8].includes(method))return null;
  const name=b.subarray(cursor+46,cursor+46+nameLen).toString('utf8');
  if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').includes('..'))return null;
  const local=b.readUInt32LE(cursor+42);
  if(local+30>offset||b.readUInt32LE(local)!==0x04034b50)return null;
  const localFlags=b.readUInt16LE(local+6),localMethod=b.readUInt16LE(local+8);
  const localNameLen=b.readUInt16LE(local+26),localExtraLen=b.readUInt16LE(local+28);
  const payload=local+30+localNameLen+localExtraLen;
  if(localFlags!==flags||localMethod!==method||payload+packed>offset)return null;
  if(b.subarray(local+30,local+30+localNameLen).toString('utf8')!==name)return null;
  if(unpacked>0&&packed===0)return null;
  names.push(name);cursor=next;
 }
 return cursor===offset+size?names:null;
}
function hasZipContainer(bytes, extension) {
 const names=zipEntryNames(bytes);
 if(!names||!names.some(name=>!name.endsWith('/')))return false;
 const required={
  '.docx':['word/document.xml'],
  '.xlsx':['xl/workbook.xml'],
  '.pptx':['ppt/presentation.xml'],
  '.odt':['mimetype','content.xml'],
  '.ods':['mimetype','content.xml'],
  '.epub':['mimetype','META-INF/container.xml'],
  '.3mf':['3D/3dmodel.model'],
  '.key':['index.apxl']
 }[extension];
 return !required||required.every(entry=>names.includes(entry));
}
export function isValidDeliverableArtifact(bytes,extension){
 const b=Buffer.from(bytes||[]),ext=String(extension||'').toLowerCase();
 if(b.length<16)return false;
 if(ext==='.pdf')return b.subarray(0,5).toString('ascii')==='%PDF-';
 if(['.docx','.xlsx','.pptx','.odt','.epub','.ods','.key','.3mf','.zip'].includes(ext))return hasZipContainer(b,ext);
 if(ext==='.rtf')return /^\{\\rtf\d/i.test(b.toString('utf8',0,32));
 if(['.tif','.tiff'].includes(ext)){
  return b.length>=8&&((b[0]===0x49&&b[1]===0x49&&((b[2]===0x2a&&b[3]===0x00)||(b[2]===0x2b&&b[3]===0x00)))||(b[0]===0x4d&&b[1]===0x4d&&((b[2]===0x00&&b[3]===0x2a)||(b[2]===0x00&&b[3]===0x2b))));
 }
 if(ext==='.aac')return b[0]===0xff&&(b[1]&0xf6)===0xf0;
 if(ext==='.parquet')return b.subarray(0,4).toString('ascii')==='PAR1'&&b.subarray(-4).toString('ascii')==='PAR1';
 if(ext==='.glb')return b.subarray(0,4).toString('ascii')==='glTF';
 if(ext==='.gltf'||ext==='.json'){
  try{JSON.parse(b.toString('utf8'));return true;}catch{return false;}
 }
 if(ext==='.step'||ext==='.stp')return /^ISO-10303-21/i.test(b.toString('utf8',0,200));
 if(ext==='.stl'){
  if(b.length>=84&&84+b.readUInt32LE(80)*50===b.length)return true;
  return /^solid\b/i.test(b.toString('utf8',0,100));
 }
 if(ext==='.obj')return /^(?:v|o|g|f)\s/m.test(b.toString('utf8',0,2000));
 if(['.md','.txt','.html','.csv','.tsv','.ics','.ino'].includes(ext)){
  const text=b.toString('utf8');
  return !text.includes('\u0000')&&text.trim().length>=16;
 }
 return false;
}
export async function verifyProductAcceptance({requestJson,download,preferredVillaId}={}){
 const all=await requestJson('/api/villas'),rows=Array.isArray(all)?all:all.villas;
 if(!Array.isArray(rows))throw Error('PRODUCT_LIST_INVALID');
 const preferred=preferredVillaId?Number(preferredVillaId):null;
 if(preferred!==null&&(!Number.isSafeInteger(preferred)||preferred<1))throw Error('PRODUCT_VILLA_ID_INVALID');
 const candidates=rows.filter(v=>Number.isSafeInteger(Number(v.id))&&Number(v.id)>0&&(!preferred||Number(v.id)===preferred)).sort((a,b)=>Number(b.tasks_done||0)-Number(a.tasks_done||0)).slice(0,10);
 for(const villa of candidates){
  const id=Number(villa.id),product=await requestJson(`/api/villas/${id}/product`);
  if(product.verified!==true||!Array.isArray(product.blockers)||product.blockers.length)continue;
  const build=await requestJson(`/api/villas/${id}/build`);if(build.status!=='ready')continue;
  const bytes=await download(`/api/villas/${id}/build/download`);
  // Medien-Produkte liefern die Datei selbst, keine Quell-ZIP. Geprueft wird
  // dann der echte Container (ftyp/RIFF/OggS ...), nicht die Endung.
  const artifact=String(build.artifact||'');
  const extension=artifact.includes('.')?artifact.slice(artifact.lastIndexOf('.')).toLowerCase():'';
  if(build.artifactType==='media'||(extension&&['.mp4','.webm','.mov','.m4v','.mp3','.wav','.ogg','.m4a','.aac','.flac','.png','.jpg','.jpeg','.webp','.svg','.tif','.tiff'].includes(extension))){
   if(!isPlayableArtifact(bytes,extension))continue;
   return {villaId:id,verified:true,media:{extension,bytes:Buffer.from(bytes).length}};
  }
   if(build.artifactType==='deliverable'){
    if(!isValidDeliverableArtifact(bytes,extension))continue;
    return {villaId:id,verified:true,deliverable:{extension,bytes:Buffer.from(bytes).length}};
   }
  const archive=inspectProductZip(bytes);
  return {villaId:id,verified:true,archive};
 }
 throw Error('PRODUCT_ACCEPTANCE_MISSING: no verified Villa app with a ready downloadable build.');
}
