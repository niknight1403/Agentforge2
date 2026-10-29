/** Download only a ready Villa product; never package a replacement landing page. */
import {appendFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function fetchVillaBuild({baseUrl='https://hub.cybersarah-ki.com',email,password,villaId,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxPolls=24}={}) {
 const origin=new URL(baseUrl);
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))throw Error('Invalid hub origin.');
 const id=Number(villaId);
 if(!Number.isSafeInteger(id)||id<1||!email||!password)throw Error('Villa ID and hub credentials are required.');
 let token='';
 async function request(path,body,binary=false) {
  // Retry only safe reads. A build POST may have succeeded despite a lost response.
  for(let attempt=0;attempt<3;attempt++) {
   let response;
   try{response=await fetchImpl(origin.origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(binary?120000:30000),redirect:'error'});}
   catch{if(!body&&attempt<2){await sleep(1000*(attempt+1));continue;}throw Error(`Hub ${path}: connection failed.`);}
   if(!body&&[429,502,503,504].includes(response.status)&&attempt<2){await response.body?.cancel().catch(()=>{});await sleep(1000*(attempt+1));continue;}
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`Hub ${path}: HTTP ${response.status}`);}
   if(binary){
    if(Number(response.headers.get('content-length'))>50*1024*1024){await response.body?.cancel();throw Error('Villa build exceeds 50 MiB.');}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>50*1024*1024)throw Error('Villa build exceeds 50 MiB.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
    const bytes=Buffer.concat(chunks);
    if(bytes.length<22||bytes.readUInt32LE(0)!==0x04034b50)throw Error('Hub returned no valid ZIP product.');
    return bytes;
   }
   try{return await response.json();}catch{throw Error(`Hub ${path}: invalid JSON response.`);}
  }
 }
 const login=await request('/api/auth/login',{email,password});
 if(typeof login.token!=='string'||!login.token)throw Error('Hub login returned no session.');token=login.token;
 const all=await request('/api/villas'),villas=Array.isArray(all)?all:all.villas;
 const villa=Array.isArray(villas)&&villas.find(v=>Number(v.id)===id);
 if(!villa)throw Error('Requested villa does not exist or is inaccessible.');
 const path=`/api/villas/${id}/build`;
 let build=await request(path);
 if(build.status!=='ready') {
  if(!['building','queued','running'].includes(build.status))await request(path,{});
  for(let i=0;i<maxPolls;i++){await sleep(5000);build=await request(path);if(['ready','failed'].includes(build.status))break;}
 }
 if(build.status!=='ready')throw Error(`Villa product is not ready (${String(build.status||'unknown').replace(/[^a-z_]/gi,'').slice(0,30)}); APK release blocked.`);
 const bytes=await request(path+'/download',null,true);
 return {name:String(villa.name||`Villa ${id}`).replace(/[\r\n\x00-\x1f\x7f]/g,' ').slice(0,160),bytes};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{
  const out=await fetchVillaBuild({email:process.env.VF_ADMIN_EMAIL,password:process.env.VF_ADMIN_PASSWORD,villaId:process.env.VILLA_ID});
  writeFileSync('/tmp/villa.zip',out.bytes);
  if(process.env.GITHUB_ENV)appendFileSync(process.env.GITHUB_ENV,`VILLA_NAME=${out.name}\n`);
  console.log(`Verified villa build downloaded (${out.bytes.length} bytes).`);
 }catch(e){console.error(e.message);process.exitCode=1;}
}
