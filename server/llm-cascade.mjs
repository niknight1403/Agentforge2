import { createHash } from 'node:crypto';
import { freeOnlyEnabled,isFreeRoute,isLocalRoute,routeTier } from './llm-config.mjs';
export class LlmUnavailableError extends Error {
 constructor(attempts=[]) {super('Kein echtes Sprachmodell erreichbar. Cloud-Zugänge, Modellstatus und lokale LLM-Verbindung prüfen; die Anfrage wurde nicht durch einen regelbasierten Planer ersetzt.');this.name='LlmUnavailableError';this.code='LLM_UNAVAILABLE';this.statusCode=503;this.retryAfter=15;this.attempts=attempts;}
}
/** Single pass, no cooldown sleeps and no duplicate endpoint/model attempts. */
export function createCascade({routes,key,call,success=()=>{},failure=()=>{},clock=Date.now}) {
 const inFlight=new Map(),credentialBlocks=new Map();
 return async function cascade(messages,opts={}) {
  const attempted=[],seen=new Set();
  const ordered=routes().filter(r=>r.provider!=='offline' && (!freeOnlyEnabled()||isFreeRoute(r)) && (!r.key_env||key(r.key_env)))
   .filter(r=>Number(r.cooldown_until||0)<=clock())
   .sort((a,b)=>routeTier(a)-routeTier(b)||Number(a.priority)-Number(b.priority)||Number(b.weight||1)-Number(a.weight||1)||Number(a.last_used||0)-Number(b.last_used||0)||a.id-b.id);
  const deadline=clock()+Math.max(1000,Math.min(Number(opts.totalTimeoutMs)||120000,600000));
  const cloudDeadline=Math.min(deadline,clock()+Math.max(1000,Math.min(Number(process.env.VF_LLM_CLOUD_BUDGET_MS)||24000,60000)));
  for(const r of ordered) {
   if(!isLocalRoute(r) && clock()>=cloudDeadline)continue;
   const credential=r.key_env ? r.base_url+'|'+createHash('sha256').update(String(key(r.key_env))).digest('hex') : '';
   if(credential && (credentialBlocks.get(credential)||0)>clock())continue;
   const identity=`${r.base_url.replace(/\/$/,'')}|${r.model}|${r.key_env||''}`;
   if(seen.has(identity))continue;seen.add(identity);
   if(clock()>=deadline)break;
   const limit=isLocalRoute(r)?Math.max(1,Number(process.env.OLLAMA_MAX_PARALLEL)||1):Math.max(1,Number(process.env.VF_LLM_ROUTE_CONCURRENCY)||3);
   if((inFlight.get(r.base_url)||0)>=limit) {attempted.push({route:r.name,code:'BUSY'});continue;}
   inFlight.set(r.base_url,(inFlight.get(r.base_url)||0)+1);
   const started=clock();
   try {
    const defaultMs=isLocalRoute(r)?90000:Math.max(500,Math.min(Number(process.env.VF_LLM_CLOUD_TIMEOUT_MS)||8000,30000));
    const timeoutMs=Math.max(1,Math.min(Number(opts.timeoutMs)||defaultMs,defaultMs,(isLocalRoute(r)?deadline:cloudDeadline)-clock()));
    const out=await call(r,messages,{...opts,timeoutMs});
    if(out?.offline||!String(out?.content||'').trim())throw Object.assign(new Error('Keine echte Modellantwort'),{code:'INVALID_RESPONSE'});
    success(r,out,clock()-started);
    return {...out,offline:false,failovers:attempted};
   }catch(e){
    if(credential && [401,403,429].includes(e.status))credentialBlocks.set(credential,clock()+(e.status===429?Math.max(120000,Math.min(Number(e.retryAfterMs)||0,600000)):300000));
    const code=e.busy?'BUSY':e.status ? `HTTP_${e.status}` : /timeout|abort/i.test(e.name||'')?'TIMEOUT':(e.code||'CONNECTION_ERROR');
    attempted.push({route:r.name,code});failure(r,e);
    opts.onFailover?.(r.name,code);
   }finally {inFlight.set(r.base_url,Math.max(0,(inFlight.get(r.base_url)||1)-1));}
  }
  throw new LlmUnavailableError(attempted);
 };
}
