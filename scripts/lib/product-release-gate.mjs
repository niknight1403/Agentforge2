/** Real product acceptance is independent of model and hub availability. */
const MAX_CANDIDATES = 10;

function safeFailureCode(error) {
 const message=String(error?.message||'');
 const productCode=message.match(/\b(PRODUCT_(?:ARCHIVE_INVALID|ARCHIVE_UNSAFE|APP_FILES_MISSING|ARCHIVE_TOO_LARGE|DOWNLOAD_HTTP_\d{3}))\b/);
 if(productCode)return productCode[1].toLowerCase();
 const httpStatus=message.match(/\bHTTP\s+(\d{3})\b/i);
 return httpStatus?`http_${httpStatus[1]}`:'request_failed';
}

function blockerCategories(blockers) {
 const counts={};
 for(const blocker of blockers){
  const text=String(blocker).toLowerCase()
   .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi,' ')
   .replace(/\b(?:token|secret|password|api[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi,' ');
  const category=/review|reviewer|critic|reviewer|pr[uü]fung/.test(text)?'review'
   :/capabilit|provider|route|anbieter|kontingent/.test(text)?'capability'
   :/source|quelle|quell|projektordner|implementier|datei|artefakt/.test(text)?'source_or_artifact'
   :/build/.test(text)?'build'
   :/test|smoke/.test(text)?'tests_or_smoke'
   :/verif|pr[uü]fnachweis|fingerprint/.test(text)?'verification'
   :/task|aufgabe|offen|fehlgeschlagen/.test(text)?'tasks'
   :'other';
  counts[category]=(counts[category]||0)+1;
 }
 return counts;
}

function safeBuildStatus(status) {
 const value=String(status||'').toLowerCase();
 return ['none','ready','unverified','building','queued','running','pending','failed'].includes(value)?value:'unknown';
}

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
 const paginationKeys=['next','nextCursor','hasMore','total','page','perPage','limit','offset','pagination'];
 const paginationMetadataPresent=!!all&&!Array.isArray(all)&&paginationKeys.some(key=>Object.hasOwn(all,key));
 const preferred=preferredVillaId?Number(preferredVillaId):null;
 if(preferred!==null&&(!Number.isSafeInteger(preferred)||preferred<1))throw Error('PRODUCT_VILLA_ID_INVALID');
 const validRows=rows.filter(v=>Number.isSafeInteger(Number(v.id))&&Number(v.id)>0);
 const candidates=validRows.filter(v=>!preferred||Number(v.id)===preferred).sort((a,b)=>Number(b.tasks_done||0)-Number(a.tasks_done||0)).slice(0,MAX_CANDIDATES);
 const checked=[];
 for(const villa of candidates){
  const id=Number(villa.id),diagnostic={id,product:'not_checked',blockerCount:null,blockerCategories:{},build:'not_checked',download:'not_attempted'};
  checked.push(diagnostic);
  let product;
  try{product=await requestJson(`/api/villas/${id}/product`);}
  catch(error){diagnostic.product=`request_failed_${safeFailureCode(error)}`;continue;}
  if(!product||typeof product!=='object'||Array.isArray(product)){
   diagnostic.product='invalid_response';
  }else{
   const blockers=Array.isArray(product.blockers)?product.blockers:null;
   diagnostic.blockerCount=blockers?.length??null;
   if(blockers)diagnostic.blockerCategories=blockerCategories(blockers);
   if(product.verified!==true)diagnostic.product='not_verified';
   else if(!blockers)diagnostic.product='invalid_blockers';
   else if(blockers.length)diagnostic.product='verified_with_blockers';
   else diagnostic.product='verified';
  }
  let build;
  try{build=await requestJson(`/api/villas/${id}/build`);}
  catch(error){diagnostic.build=`request_failed_${safeFailureCode(error)}`;continue;}
  diagnostic.build=safeBuildStatus(build?.status);
  if(diagnostic.product!=='verified'||diagnostic.build!=='ready')continue;
  try{
   const archive=inspectProductZip(await download(`/api/villas/${id}/build/download`));
   diagnostic.download='valid_zip';
   return {villaId:id,verified:true,archive};
  }catch(error){diagnostic.download=`failed_${safeFailureCode(error)}`;}
 }
 const summary={
  code:'PRODUCT_ACCEPTANCE_MISSING',
  apiListShape:Array.isArray(all)?'array':'object_with_villas',
  paginationMetadataPresent,
  listedVillas:rows.length,
  validVillaIds:validRows.length,
  selectedCandidates:candidates.length,
  candidateLimit:MAX_CANDIDATES,
  candidatesOmitted:Math.max(0,validRows.filter(v=>!preferred||Number(v.id)===preferred).length-candidates.length),
  selectionOrder:'tasks_done_desc_then_response_order',
  preferredVillaFound:preferred===null||validRows.some(v=>Number(v.id)===preferred),
  checked
 };
 throw Error(`PRODUCT_ACCEPTANCE_MISSING: ${JSON.stringify(summary)}`);
}
