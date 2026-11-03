/** One-shot live prompt-to-product proof. Fail closed; never synthesize success. */
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function requireFreeRoutes(status){
 if(status?.freeOnly!==true)throw Error('PAID_ROUTES_NOT_DISABLED');
 if(!Array.isArray(status.routes)||!status.routes.some(r=>r.eligible===true&&r.isFree===true))throw Error('NO_ELIGIBLE_FREE_LLM_ROUTE');
 return true;
}
export function validateEvidence(evidence,id){
 if(evidence?.verified!==true||evidence.downloadAvailable!==true)throw Error('PRODUCT_NOT_VERIFIED');
 const a=evidence.artifact;
 if(!a||a.url!=='/api/villas/'+id+'/build/download'||!/^[a-f0-9]{64}$/i.test(a.sha256||'')||!Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<22||a.sizeBytes>64*1024*1024)throw Error('INVALID_ARTIFACT_EVIDENCE');
 return a;
}
export async function liveProof({baseUrl='https://hub.cybersarah-ki.com',email,password,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),polls=48}={}){
 const report={result:'INCOMPLETE',phase:'PREFLIGHT',projectId:0,villaId:0,blockers:[]};
 try{
  if(!email||!password)throw Error('ADMIN_CREDENTIALS_MISSING');
  const origin=new URL(baseUrl);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('INVALID_HUB_ORIGIN');
  let token='';
  async function api(path,body=null,timeout=30000){
   const r=await fetchImpl(origin.origin+path,{method:body===null?'GET':'POST',
    headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
    ...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout),redirect:'error'});
   if(!r.ok)throw Error('HUB_HTTP_'+r.status+'_'+path.replace(/[0-9]+/g,'id'));
   return r.json();
  }
  report.phase='HEALTH';
  if((await api('/api/health')).ok!==true)throw Error('HUB_UNHEALTHY');
  report.phase='AUTH';
  const login=await api('/api/auth/login',{email,password});
  if(!login?.token)throw Error('HUB_LOGIN_FAILED');
  token=login.token;
  report.phase='FREE_ONLY';
  requireFreeRoutes(await api('/api/llm/status'));
  report.phase='AUTO_CREATE';
  const idea='Entwickle eine mobile Web-App mit lokaler Aufgabenliste, Hinzufuegen, Erledigen, Tests, produktivem Web-Build und geprueftem Download. Referenz '+String(process.env.GITHUB_RUN_ID||'live');
  const project=await api('/api/deep/projects',{idea},240000);
  report.projectId=Number(project?.id||0);
  report.villaId=Number(project?.development?.villaId||0);
  if(project?.intent!=='AUTO_BUILD'||!report.projectId)throw Error('PROMPT_NOT_AUTO_DISPATCHED');
  if(!report.villaId||project?.development?.ok!==true)throw Error('VILLA_NOT_STARTED_'+String(project?.development?.code||'UNKNOWN').replace(/[^A-Za-z0-9_-]/g,''));
  report.phase='WAIT_FOR_PRODUCT';
  let evidence;
  for(let i=0;i<polls;i++){
   evidence=await api('/api/villas/'+report.villaId+'/delivery-evidence',null,60000);
   if(evidence?.verified===true&&evidence.downloadAvailable===true)break;
   const build=await api('/api/villas/'+report.villaId+'/build');
   report.buildStatus=String(build?.status||'none');
   if(build?.status==='failed')throw Error('AUTONOMOUS_BUILD_FAILED');
   if(build?.status==='unverified')throw Error('BUILD_UNVERIFIED');
   await sleep(15000);
  }
  if(evidence?.verified!==true)throw Error('AUTONOMOUS_PRODUCT_TIMEOUT');
  report.phase='VERIFY_DOWNLOAD';
  const a=validateEvidence(evidence,report.villaId);
  const r=await fetchImpl(origin.origin+a.url,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!r.ok)throw Error('DOWNLOAD_HTTP_'+r.status);
  if(Number(r.headers.get('content-length')||0)>64*1024*1024)throw Error('OVERSIZE_DOWNLOAD');
  const bytes=Buffer.from(await r.arrayBuffer());
  if(bytes.length!==a.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==a.sha256.toLowerCase())throw Error('DOWNLOAD_HASH_MISMATCH');
  report.result='COMPLETE';report.phase='DELIVERED_VERIFIED';
  report.artifact={name:a.name,sizeBytes:bytes.length,sha256:a.sha256,url:a.url};
 }catch(error){report.blockers=[String(error?.message||error).slice(0,200)];}
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const report=await liveProof({baseUrl:process.env.VF_HUB_URL||undefined,email:process.env.VF_ADMIN_EMAIL,password:process.env.VF_ADMIN_PASSWORD});
 writeFileSync(process.env.VF_E2E_REPORT_PATH||'product-factory-e2e-report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
 if(report.result!=='COMPLETE')process.exitCode=1;
}
