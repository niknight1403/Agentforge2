/** Real product acceptance is independent of model and hub availability. */
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
export async function verifyProductAcceptance({requestJson,download,preferredVillaId}={}){
 const all=await requestJson('/api/villas'),rows=Array.isArray(all)?all:all.villas;
 if(!Array.isArray(rows))throw Error('PRODUCT_LIST_INVALID');
 const preferred=preferredVillaId?Number(preferredVillaId):null;
 if(preferred!==null&&(!Number.isSafeInteger(preferred)||preferred<1))throw Error('PRODUCT_VILLA_ID_INVALID');
 const candidates=rows.filter(v=>Number.isSafeInteger(Number(v.id))&&Number(v.id)>0&&(!preferred||Number(v.id)===preferred)).sort((a,b)=>Number(b.tasks_done||0)-Number(a.tasks_done||0)).slice(0,10);
 for(const villa of candidates){
  const id=Number(villa.id),product=await requestJson(`/api/villas/${id}/product`);
  if(product.verified!==true||Number(product.unfinishedTasks)!==0||!Array.isArray(product.blockers)||product.blockers.length)continue;
  const build=await requestJson(`/api/villas/${id}/build`);if(build.status!=='ready')continue;
  const archive=inspectProductZip(await download(`/api/villas/${id}/build/download`));
  return {villaId:id,verified:true,archive};
 }
 throw Error('PRODUCT_ACCEPTANCE_MISSING: no verified Villa app with a ready downloadable build.');
}
