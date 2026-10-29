/** Release gate against the deployed configuration, never a rule-based answer. */
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {VERSION} from '../server/version.mjs';

export async function verifyLiveLlm({baseUrl,email,password,expectedVersion=VERSION,fetchImpl=fetch,clock=Date.now,timeoutMs=120000}={}) {
  const url=new URL(baseUrl);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Smoke endpoint must be an HTTPS origin or loopback fixture.');
  if(!email||!password)throw Error('Production smoke credentials are not configured.');
  const signal=AbortSignal.timeout(Math.max(1000,Math.min(180000,Number(timeoutMs)||120000)));
  async function request(path,body,token) {
    const response=await fetchImpl(url.origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal});
    if(!response.ok){
      let detail;try{detail=await response.json();}catch{}
      const code=String(detail?.code||'').match(/^[A-Z_]{1,60}$/)?.[0];
      const reset=Number.isSafeInteger(detail?.resetsAt)?` resetsAt=${new Date(detail.resetsAt).toISOString()}`:'';
      throw Error(`Live LLM smoke ${path}: HTTP ${response.status}${code?' '+code:''}${reset}`);
    }
    try{return await response.json();}catch{throw Error(`Live LLM smoke ${path}: invalid JSON`);}
  }
  const login=await request('/api/auth/login',{email,password});
  if(typeof login.token!=='string'||!login.token)throw Error('Live LLM smoke: login returned no session.');
  const before=await request('/api/health',null,login.token);
  if(before.ok!==true||before.version!==expectedVersion||before.llm?.freeOnly!==true)throw Error('Live LLM smoke: production version or free-only policy mismatch.');
  const started=clock();
  const out=await request('/api/master/chat',{message:'Antworte ausschließlich mit einem kurzen Satz, dass die Modellverbindung geprüft ist. Ändere keine Einstellungen und führe keine Aktionen aus.',requestId:randomUUID()},login.token);
  if(out.ok!==true||out.offline===true||typeof out.answer!=='string'||out.answer.trim().length<12||!Array.isArray(out.steps)||out.steps.length)throw Error('Live LLM smoke: no verified answer without side effects.');
  const after=await request('/api/health',null,login.token);
  const replyAt=Number(after.llm?.lastSuccessfulReplyAt)||0;
  if(after.ok!==true||after.version!==expectedVersion||after.llm?.freeOnly!==true||replyAt<started-5000||replyAt<=Number(before.llm?.lastSuccessfulReplyAt||0)||!after.llm?.lastSuccessfulRoute)throw Error('Live LLM smoke: no fresh model-reply evidence.');
  return {ok:true,version:after.version,route:String(after.llm.lastSuccessfulRoute).slice(0,120),latencyMs:clock()-started};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log('LIVE_LLM_VERIFIED',JSON.stringify(await verifyLiveLlm({baseUrl:process.env.VF_SMOKE_BASE_URL,email:process.env.VF_ADMIN_EMAIL,password:process.env.VF_ADMIN_PASSWORD})));}
  catch(error){console.error(String(error?.message||'Live LLM smoke failed'));process.exitCode=1;}
}
