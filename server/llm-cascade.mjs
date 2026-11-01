import { createHash } from 'node:crypto';
import { freeOnlyEnabled,isFreeRoute,isLocalRoute,routeTier } from './llm-config.mjs';
import { withOtelSpan } from './otel.mjs';
const finiteLimit=(value,fallback,min,max)=>{const n=Number(value);return Number.isFinite(n)&&n>0?Math.max(min,Math.min(max,Math.floor(n))):fallback;};
export const normalizeEndpoint=value=>String(value||'').replace(/\/+$/,'');
export class LlmUnavailableError extends Error {
 constructor(attempts=[],retryAfter=15) {super('Kein echtes Sprachmodell erreichbar. Cloud-Zugänge, Modellstatus und lokale LLM-Verbindung prüfen; die Anfrage wurde nicht durch einen regelbasierten Planer ersetzt.');this.name='LlmUnavailableError';this.code='LLM_UNAVAILABLE';this.statusCode=503;this.retryAfter=Math.max(15,Math.min(600,Math.ceil(Number(retryAfter)||15)));this.attempts=attempts;}
}
const QUALITY_ROLES=new Set(['ROOT','CODER','ARCHITECT','REVIEWER','INTEGRATOR']);
export function orderCascadeRoutes(routes,{role='',strategy='',freeOnlyMode=freeOnlyEnabled(),preferredModel=''}={}) {
 const localFirst=strategy==='LOCAL_FIRST'||(strategy!=='FALLBACK'&&!QUALITY_ROLES.has(String(role||'').toUpperCase()));
 const checkedAt=Date.now();
 const verifiedCloud=r=>!isLocalRoute(r)&&r.status==='OK'&&Number(r.last_used)>0&&checkedAt-Number(r.last_used)>=0&&checkedAt-Number(r.last_used)<300000;
 return routes.filter(r=>r.provider!=='offline'&&(!freeOnlyMode||isFreeRoute(r)))
  .sort((a,b)=>(preferredModel?Number(String(b.model||'')===preferredModel)-Number(String(a.model||'')===preferredModel):0)||(localFirst?Number(!isLocalRoute(a))-Number(!isLocalRoute(b)):0)||Number(verifiedCloud(b))-Number(verifiedCloud(a))||routeTier(a)-routeTier(b)||Number(a.priority)-Number(b.priority)||Number(b.weight||1)-Number(a.weight||1)||Number(a.last_used||0)-Number(b.last_used||0)||a.id-b.id);
}
/** Single pass, no cooldown sleeps and no duplicate endpoint/model attempts. */
export function createCascade({routes,key,call,success=()=>{},failure=()=>{},clock=Date.now,freeOnly=freeOnlyEnabled}) {
 const inFlight=new Map(),credentialBlocks=new Map(),permitWaiters=new Map(),interactiveStreak=new Map();
 async function acquire(base,limit,deadline,signal,priority) {
  signal?.throwIfAborted();
  const current=inFlight.get(base)||0;
  if(current<limit){inFlight.set(base,current+1);return true;}
  const waitMs=Math.max(0,deadline-clock());
  if(!waitMs)return false;
  const maxQueue=finiteLimit(process.env.VF_LLM_MAX_QUEUE,64,1,512);
  if((permitWaiters.get(base)?.length||0)>=maxQueue)return false;
  return new Promise((resolve,reject)=>{
   let finished=false,timer;
   const queue=permitWaiters.get(base)||[];
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   const remove=()=>{const i=queue.indexOf(waiter);if(i>=0)queue.splice(i,1);if(!queue.length)permitWaiters.delete(base);};
   const abort=()=>{if(finished)return;finished=true;cleanup();remove();reject(signal.reason);};
   const waiter={
    interactive:priority==='interactive',limit,
    grant(){if(finished)return false;finished=true;cleanup();resolve(true);return true;},
    expire(){if(finished)return;finished=true;cleanup();remove();resolve(false);}
   };
   timer=setTimeout(()=>waiter.expire(),waitMs);
   queue.push(waiter);permitWaiters.set(base,queue);
   signal?.addEventListener('abort',abort,{once:true});
  });
 }
 function release(base) {
  const remaining=Math.max(0,(inFlight.get(base)||1)-1);
  if(remaining)inFlight.set(base,remaining);else inFlight.delete(base);
  const queue=permitWaiters.get(base);
  while(queue?.length){
   const high=queue.findIndex(w=>w.interactive&&remaining<w.limit),normal=queue.findIndex(w=>!w.interactive&&remaining<w.limit);
   if(high<0&&normal<0)return;
   const preferHigh=high>=0&&((interactiveStreak.get(base)||0)<2||normal<0);
   const [waiter]=queue.splice(preferHigh?high:normal,1);
   if(!queue.length)permitWaiters.delete(base);
   if(waiter.grant()){inFlight.set(base,remaining+1);interactiveStreak.set(base,waiter.interactive?(interactiveStreak.get(base)||0)+1:0);return;}
  }
  permitWaiters.delete(base);
  if(!remaining)interactiveStreak.delete(base);
 }
 const cascade = async function(messages,opts={}) {
  opts.signal?.throwIfAborted();
  const attempted=[],seen=new Set();let earliestRetryAt=Infinity;
  for(const [credential,until] of credentialBlocks)if(until<=clock())credentialBlocks.delete(credential);
  const freeOnlyMode=typeof freeOnly==='function'?freeOnly():Boolean(freeOnly);
  const configuredRoutes=routes().filter(r=>(!r.key_env||key(r.key_env))&&(!freeOnlyMode||isFreeRoute(r))&&r.provider!=='offline');
  for(const r of configuredRoutes)if(Number(r.cooldown_until)>clock())earliestRetryAt=Math.min(earliestRetryAt,Number(r.cooldown_until));
  const candidateRoutes=configuredRoutes.filter(r=>Number(r.cooldown_until||0)<=clock());
  const ordered=orderCascadeRoutes(candidateRoutes,{strategy:opts.strategy,role:opts.role,freeOnlyMode,preferredModel:String(opts.preferredModel||'').slice(0,120)});
  const deadline=clock()+finiteLimit(opts.totalTimeoutMs,120000,1000,600000);
  // Cloud time is consumed by cloud work, never by earlier local work.
  let cloudRemaining=finiteLimit(process.env.VF_LLM_CLOUD_BUDGET_MS,24000,1000,60000);
  const busyEndpoints=new Set();
  for(const r of ordered) {
   opts.signal?.throwIfAborted();
   if(!isLocalRoute(r) && cloudRemaining<=0)continue;
   const cloudDeadline=Math.min(deadline,clock()+cloudRemaining);
   const routeStarted=clock();
   const credential=r.key_env ? normalizeEndpoint(r.base_url)+'|'+createHash('sha256').update(String(key(r.key_env))).digest('hex') : '';
   if(credential && (credentialBlocks.get(credential)||0)>clock()){earliestRetryAt=Math.min(earliestRetryAt,credentialBlocks.get(credential));continue;}
   const identity=`${normalizeEndpoint(r.base_url)}|${r.model}|${credential||'public'}`;
   const endpoint=normalizeEndpoint(r.base_url);
   if(busyEndpoints.has(endpoint))continue;
   if(seen.has(identity))continue;seen.add(identity);
   if(clock()>=deadline)break;
   const limit=isLocalRoute(r)?finiteLimit(process.env.OLLAMA_MAX_PARALLEL,1,1,32):finiteLimit(process.env.VF_LLM_ROUTE_CONCURRENCY,3,1,32);
   // Serialize local work within the request deadline. Queue capacity and
   // cancellation keep concurrent villa starts bounded and stoppable.
   const localQueueWaitMs=opts.priority==='interactive'?finiteLimit(process.env.VF_LLM_INTERACTIVE_LOCAL_QUEUE_WAIT_MS,1500,25,3000):Math.max(25,Math.min(Number(process.env.VF_LLM_LOCAL_QUEUE_WAIT_MS)||90000,120000));
   const cloudQueueWaitMs=opts.priority==='interactive'?finiteLimit(process.env.VF_LLM_INTERACTIVE_QUEUE_WAIT_MS,1500,25,3000):finiteLimit(process.env.VF_LLM_CLOUD_QUEUE_WAIT_MS,250,25,1000);
   const slotDeadline=isLocalRoute(r)?Math.min(deadline,clock()+localQueueWaitMs):Math.min(cloudDeadline,clock()+cloudQueueWaitMs);
  // Hintergrundarbeit (Villen) laesst auf jedem Endpunkt eine Spur frei, egal ob
 // lokal oder entfernt. Sonst belegt sie bei Ollama-Knoten alle Plaetze und die
 // interaktive Anfrage bekommt nur BUSY, obwohl das Modell warm ist.
 const admissionLimit=opts.priority!=='interactive'&&limit>1?limit-1:limit;
   if(!await acquire(endpoint,admissionLimit,slotDeadline,opts.signal,opts.priority)){attempted.push({route:r.name,code:'BUSY'});busyEndpoints.add(endpoint);earliestRetryAt=Math.min(earliestRetryAt,clock()+15000);continue;}
   if(opts.signal?.aborted){release(endpoint);opts.signal.throwIfAborted();}
   if(clock()>=deadline){release(endpoint);break;}
    const started=clock();
   try {
    opts.signal?.throwIfAborted();
    // Lokale Modelle laufen hinter mehreren getesteten Alternativen. Begrenze
    // einen einzelnen langsamen Versuch, damit die Kaskade schnell weiterkommt.
    // Große lokale Installationen können den Wert bis 90 s anheben.
    // Hard provider deadline: fail over after 15 seconds instead of allowing
    // one stalled endpoint to hold the task or villa slot.
    /* Deckel bewusst hoch: Ein 4-5k-Token-Prompt braucht auf einem 3B-Modell
       mit 43 Tokens/s rund 100 s. Der fruehere Deckel von 15 s (lokal) bzw.
       8 s (Cloud) liess JEDEN Versuch scheitern - die Kaskade meldete dann
       LLM_UNAVAILABLE, obwohl Modelle erreichbar waren. */
    const localTimeoutMs=Math.max(1000,Math.min(Number(process.env.VF_LLM_LOCAL_TIMEOUT_MS)||60000,180000));
    const defaultMs=isLocalRoute(r)?localTimeoutMs:Math.max(500,Math.min(Number(process.env.VF_LLM_CLOUD_TIMEOUT_MS)||25000,60000));
    // Preserve time for a different local endpoint during interactive requests.
    // Background generation and the final available endpoint keep their budget.
    const hasLocalAlternative=opts.priority==='interactive'&&isLocalRoute(r)&&ordered.slice(ordered.indexOf(r)+1).some(next=>{
     const nextEndpoint=normalizeEndpoint(next.base_url);
     const nextCredential=next.key_env?nextEndpoint+'|'+createHash('sha256').update(String(key(next.key_env))).digest('hex'):'';
     const nextIdentity=`${nextEndpoint}|${next.model}|${nextCredential||'public'}`;
     return isLocalRoute(next)&&nextEndpoint!==endpoint&&!busyEndpoints.has(nextEndpoint)&&!seen.has(nextIdentity)&&(!nextCredential||(credentialBlocks.get(nextCredential)||0)<=clock());
    });
    const attemptBudget=hasLocalAlternative?Math.max(1,Math.floor((deadline-clock())/2)):Infinity;
    const timeoutMs=Math.max(1,Math.min(Number(opts.timeoutMs)||defaultMs,defaultMs,attemptBudget,(isLocalRoute(r)?deadline:cloudDeadline)-clock()));
    const out=await withOtelSpan('llm.provider.request',{
     'llm.provider':String(r.provider||'unknown'),
     'llm.route':String(r.name||'unknown'),
     'llm.model':String(r.model||'unknown'),
     'llm.timeout_ms':timeoutMs
    },()=>call(r,messages,{...opts,timeoutMs}));
    opts.signal?.throwIfAborted();
    if(out?.offline||!String(out?.content||'').trim())throw Object.assign(new Error('Keine echte Modellantwort'),{code:'INVALID_RESPONSE'});
    success(r,out,clock()-started);
    return {...out,offline:false,failovers:attempted};
   }catch(e){
    if(opts.signal?.aborted)throw opts.signal.reason;
    const retryMs=e.busy?Math.max(1000,Math.min(Number(e.retryAfterMs)||15000,60000)):e.status===429?Math.max(120000,Math.min(Number(e.retryAfterMs)||0,600000)):15000;
    earliestRetryAt=Math.min(earliestRetryAt,clock()+retryMs);
    if(credential && [401,403,429].includes(e.status))credentialBlocks.set(credential,clock()+(e.status===429?Math.max(120000,Math.min(Number(e.retryAfterMs)||0,600000)):300000));
    const code=e.busy?'BUSY':e.status ? `HTTP_${e.status}` : /timeout|abort/i.test(e.name||'')?'TIMEOUT':(e.code||'CONNECTION_ERROR');
    attempted.push({route:r.name,code});failure(r,e);
    opts.onFailover?.(r.name,code);
   }finally {release(endpoint);if(!isLocalRoute(r))cloudRemaining=Math.max(0,cloudRemaining-(clock()-routeStarted));}
  }
  throw new LlmUnavailableError(attempted,Number.isFinite(earliestRetryAt)?(earliestRetryAt-clock())/1000:15);
 };
 return Object.assign(cascade, { stats: () => ({
   active: [...inFlight.values()].reduce((n,v)=>n+v,0),
   waiting: [...permitWaiters.values()].reduce((n,q)=>n+q.length,0),
   interactiveWaiting: [...permitWaiters.values()].reduce((n,q)=>n+q.filter(w=>w.interactive).length,0),
   maxQueuePerEndpoint: finiteLimit(process.env.VF_LLM_MAX_QUEUE,64,1,512)
 }) });
}
