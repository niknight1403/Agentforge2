import { createHash } from 'node:crypto';
import { freeOnlyEnabled,isFreeRoute,isLocalRoute,routeTier } from './llm-config.mjs';
import { withOtelSpan } from './otel.mjs';
export class LlmUnavailableError extends Error {
 constructor(attempts=[],retryAfter=15) {super('Kein echtes Sprachmodell erreichbar. Cloud-Zugänge, Modellstatus und lokale LLM-Verbindung prüfen; die Anfrage wurde nicht durch einen regelbasierten Planer ersetzt.');this.name='LlmUnavailableError';this.code='LLM_UNAVAILABLE';this.statusCode=503;this.retryAfter=Math.max(15,Math.min(600,Math.ceil(Number(retryAfter)||15)));this.attempts=attempts;}
}
const QUALITY_ROLES=new Set(['ROOT','CODER','ARCHITECT','REVIEWER','INTEGRATOR']);
export function orderCascadeRoutes(routes,{role='',strategy='',freeOnlyMode=freeOnlyEnabled(),preferredModel=''}={}) {
 const localFirst=strategy==='LOCAL_FIRST'||(strategy!=='FALLBACK'&&!QUALITY_ROLES.has(String(role||'').toUpperCase()));
 return routes.filter(r=>r.provider!=='offline'&&(!freeOnlyMode||isFreeRoute(r)))
  .sort((a,b)=>(preferredModel?Number(String(b.model||'')===preferredModel)-Number(String(a.model||'')===preferredModel):0)||(localFirst?Number(!isLocalRoute(a))-Number(!isLocalRoute(b)):0)||routeTier(a)-routeTier(b)||Number(a.priority)-Number(b.priority)||Number(b.weight||1)-Number(a.weight||1)||Number(a.last_used||0)-Number(b.last_used||0)||a.id-b.id);
}
/** Single pass, no cooldown sleeps and no duplicate endpoint/model attempts. */
export function createCascade({routes,key,call,success=()=>{},failure=()=>{},clock=Date.now,freeOnly=freeOnlyEnabled}) {
 const inFlight=new Map(),credentialBlocks=new Map(),permitWaiters=new Map();
 async function acquire(base,limit,deadline,signal) {
  signal?.throwIfAborted();
  const current=inFlight.get(base)||0;
  if(current<limit){inFlight.set(base,current+1);return true;}
  const waitMs=Math.max(0,deadline-clock());
  if(!waitMs)return false;
  const maxQueue=Math.max(1,Math.min(512,Number(process.env.VF_LLM_MAX_QUEUE)||64));
  if((permitWaiters.get(base)?.length||0)>=maxQueue)return false;
  return new Promise((resolve,reject)=>{
   let finished=false,timer;
   const queue=permitWaiters.get(base)||[];
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   const remove=()=>{const i=queue.indexOf(waiter);if(i>=0)queue.splice(i,1);if(!queue.length)permitWaiters.delete(base);};
   const abort=()=>{if(finished)return;finished=true;cleanup();remove();reject(signal.reason);};
   const waiter={
    grant(){if(finished)return false;finished=true;cleanup();resolve(true);return true;},
    expire(){if(finished)return;finished=true;cleanup();remove();resolve(false);}
   };
   timer=setTimeout(()=>waiter.expire(),waitMs);
   queue.push(waiter);permitWaiters.set(base,queue);
   signal?.addEventListener('abort',abort,{once:true});
  });
 }
 function release(base) {
  const queue=permitWaiters.get(base);
  while(queue?.length){const waiter=queue.shift();if(!queue.length)permitWaiters.delete(base);if(waiter.grant())return;}
  permitWaiters.delete(base);
  const remaining=Math.max(0,(inFlight.get(base)||1)-1);
  if(remaining)inFlight.set(base,remaining);else inFlight.delete(base);
 }
 return async function cascade(messages,opts={}) {
  opts.signal?.throwIfAborted();
  const attempted=[],seen=new Set();let earliestRetryAt=Infinity;
  const freeOnlyMode=typeof freeOnly==='function'?freeOnly():Boolean(freeOnly);
  const configuredRoutes=routes().filter(r=>(!r.key_env||key(r.key_env))&&(!freeOnlyMode||isFreeRoute(r))&&r.provider!=='offline');
  for(const r of configuredRoutes)if(Number(r.cooldown_until)>clock())earliestRetryAt=Math.min(earliestRetryAt,Number(r.cooldown_until));
  const candidateRoutes=configuredRoutes.filter(r=>Number(r.cooldown_until||0)<=clock());
  const ordered=orderCascadeRoutes(candidateRoutes,{strategy:opts.strategy,role:opts.role,freeOnlyMode,preferredModel:String(opts.preferredModel||'').slice(0,120)});
  const deadline=clock()+Math.max(1000,Math.min(Number(opts.totalTimeoutMs)||120000,600000));
  const cloudDeadline=Math.min(deadline,clock()+Math.max(1000,Math.min(Number(process.env.VF_LLM_CLOUD_BUDGET_MS)||24000,60000)));
  for(const r of ordered) {
   opts.signal?.throwIfAborted();
   if(!isLocalRoute(r) && clock()>=cloudDeadline)continue;
   const credential=r.key_env ? r.base_url+'|'+createHash('sha256').update(String(key(r.key_env))).digest('hex') : '';
   if(credential && (credentialBlocks.get(credential)||0)>clock()){earliestRetryAt=Math.min(earliestRetryAt,credentialBlocks.get(credential));continue;}
   const identity=`${r.base_url.replace(/\/$/,'')}|${r.model}|${r.key_env||''}`;
   if(seen.has(identity))continue;seen.add(identity);
   if(clock()>=deadline)break;
   const limit=isLocalRoute(r)?Math.max(1,Number(process.env.OLLAMA_MAX_PARALLEL)||1):Math.max(1,Number(process.env.VF_LLM_ROUTE_CONCURRENCY)||3);
   // Serialize local work within the request deadline. Queue capacity and
   // cancellation keep concurrent villa starts bounded and stoppable.
   const localQueueWaitMs=Math.max(25,Math.min(Number(process.env.VF_LLM_LOCAL_QUEUE_WAIT_MS)||90000,120000));
   const slotDeadline=isLocalRoute(r)?Math.min(deadline,clock()+localQueueWaitMs):cloudDeadline;
   if(!await acquire(r.base_url,limit,slotDeadline,opts.signal)){attempted.push({route:r.name,code:'BUSY'});earliestRetryAt=Math.min(earliestRetryAt,clock()+15000);continue;}
   if(clock()>=deadline){release(r.base_url);break;}
    const started=clock();
   try {
    opts.signal?.throwIfAborted();
    // Lokale Modelle laufen hinter mehreren getesteten Alternativen. Begrenze
    // einen einzelnen langsamen Versuch, damit die Kaskade schnell weiterkommt.
    // Große lokale Installationen können den Wert bis 90 s anheben.
    // Hard provider deadline: fail over after 15 seconds instead of allowing
    // one stalled endpoint to hold the task or villa slot.
    const localTimeoutMs=Math.max(1000,Math.min(Number(process.env.VF_LLM_LOCAL_TIMEOUT_MS)||15000,15000));
    const defaultMs=isLocalRoute(r)?localTimeoutMs:Math.max(500,Math.min(Number(process.env.VF_LLM_CLOUD_TIMEOUT_MS)||8000,15000));
    const timeoutMs=Math.max(1,Math.min(Number(opts.timeoutMs)||defaultMs,defaultMs,(isLocalRoute(r)?deadline:cloudDeadline)-clock()));
    const out=await withOtelSpan('llm.provider.request',{
     'llm.provider':String(r.provider||'unknown'),
     'llm.route':String(r.name||'unknown'),
     'llm.model':String(r.model||'unknown'),
     'llm.timeout_ms':timeoutMs
    },()=>call(r,messages,{...opts,timeoutMs}));
    if(out?.offline||!String(out?.content||'').trim())throw Object.assign(new Error('Keine echte Modellantwort'),{code:'INVALID_RESPONSE'});
    success(r,out,clock()-started);
    return {...out,offline:false,failovers:attempted};
   }catch(e){
    if(opts.signal?.aborted)throw opts.signal.reason;
    const retryMs=e.status===429?Math.max(120000,Math.min(Number(e.retryAfterMs)||0,600000)):15000;
    earliestRetryAt=Math.min(earliestRetryAt,clock()+retryMs);
    if(credential && [401,403,429].includes(e.status))credentialBlocks.set(credential,clock()+(e.status===429?Math.max(120000,Math.min(Number(e.retryAfterMs)||0,600000)):300000));
    const code=e.busy?'BUSY':e.status ? `HTTP_${e.status}` : /timeout|abort/i.test(e.name||'')?'TIMEOUT':(e.code||'CONNECTION_ERROR');
    attempted.push({route:r.name,code});failure(r,e);
    opts.onFailover?.(r.name,code);
   }finally {release(r.base_url);}
  }
  throw new LlmUnavailableError(attempted,Number.isFinite(earliestRetryAt)?(earliestRetryAt-clock())/1000:15);
 };
}
