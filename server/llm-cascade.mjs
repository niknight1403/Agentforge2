import { createHash } from 'node:crypto';
import { freeOnlyEnabled,isFreeRoute,isLocalRoute,routeTier } from './llm-config.mjs';
export class LlmUnavailableError extends Error {
 constructor(attempts=[]) {super('Kein echtes Sprachmodell erreichbar. Cloud-Zugänge, Modellstatus und lokale LLM-Verbindung prüfen; die Anfrage wurde nicht durch einen regelbasierten Planer ersetzt.');this.name='LlmUnavailableError';this.code='LLM_UNAVAILABLE';this.statusCode=503;this.retryAfter=15;this.attempts=attempts;}
}
const QUALITY_ROLES=new Set(['ROOT','CODER','ARCHITECT','REVIEWER','INTEGRATOR']);
export function orderCascadeRoutes(routes,{role='',strategy='',freeOnlyMode=freeOnlyEnabled()}={}) {
 const localFirst=strategy==='LOCAL_FIRST'||(strategy!=='FALLBACK'&&!QUALITY_ROLES.has(String(role||'').toUpperCase()));
 return routes.filter(r=>r.provider!=='offline'&&(!freeOnlyMode||isFreeRoute(r)))
  .sort((a,b)=>(localFirst?Number(!isLocalRoute(a))-Number(!isLocalRoute(b)):0)||routeTier(a)-routeTier(b)||Number(a.priority)-Number(b.priority)||Number(b.weight||1)-Number(a.weight||1)||Number(a.last_used||0)-Number(b.last_used||0)||a.id-b.id);
}
/** Single pass, no cooldown sleeps and no duplicate endpoint/model attempts. */
export function createCascade({routes,key,call,success=()=>{},failure=()=>{},clock=Date.now,freeOnly=freeOnlyEnabled}) {
 const inFlight=new Map(),credentialBlocks=new Map(),permitWaiters=new Map();
 async function acquire(base,limit,deadline) {
  const current=inFlight.get(base)||0;
  if(current<limit){inFlight.set(base,current+1);return true;}
  const waitMs=Math.max(0,deadline-clock());
  if(!waitMs)return false;
  return new Promise(resolve=>{
   let finished=false,timer;
   const queue=permitWaiters.get(base)||[];
   const waiter={
    grant(){if(finished)return false;finished=true;clearTimeout(timer);resolve(true);return true;},
    expire(){if(finished)return;finished=true;const i=queue.indexOf(waiter);if(i>=0)queue.splice(i,1);resolve(false);}
   };
   timer=setTimeout(()=>waiter.expire(),waitMs);
   queue.push(waiter);permitWaiters.set(base,queue);
  });
 }
 function release(base) {
  const queue=permitWaiters.get(base);
  while(queue?.length){const waiter=queue.shift();if(waiter.grant())return;}
  inFlight.set(base,Math.max(0,(inFlight.get(base)||1)-1));
 }
 return async function cascade(messages,opts={}) {
  const attempted=[],seen=new Set();
  const freeOnlyMode=typeof freeOnly==='function'?freeOnly():Boolean(freeOnly);
  const candidateRoutes=routes().filter(r=>(!r.key_env||key(r.key_env))&&Number(r.cooldown_until||0)<=clock());
  const ordered=orderCascadeRoutes(candidateRoutes,{strategy:opts.strategy,role:opts.role,freeOnlyMode});
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
   const slotDeadline=isLocalRoute(r)?deadline:cloudDeadline;
   if(!await acquire(r.base_url,limit,slotDeadline)){attempted.push({route:r.name,code:'BUSY'});continue;}
   if(clock()>=deadline){release(r.base_url);break;}
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
   }finally {release(r.base_url);}
  }
  throw new LlmUnavailableError(attempted);
 };
}
