import {writeFileSync} from 'node:fs';
const origin='https://hub.cybersarah-ki.com';
export async function inspectVilla({id=39,email,password,fetchImpl=fetch}={}){
 if(!Number.isSafeInteger(Number(id))||Number(id)<1)throw Error('INVALID_VILLA_ID');
 if(!email||!password)throw Error('MISSING_AUTH');
 let token='';
 async function read(path,body){
  const r=await fetchImpl(origin+path,{method:body?'POST':'GET',
   headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!r.ok)throw Error('HTTP_'+r.status+'_'+path.replace(/[0-9]+/g,'id'));
  return r.json();
 }
 token=(await read('/api/auth/login',{email,password})).token;
 if(!token)throw Error('LOGIN_FAILED');
 const [d,product,build,deliver,sched,routes]=await Promise.all([
  read('/api/villas/'+id),read('/api/villas/'+id+'/product'),read('/api/villas/'+id+'/build'),
  read('/api/villas/'+id+'/delivery-evidence'),read('/api/scheduler'),read('/api/llm/status')]);
 const failures=await read('/api/villas/'+id+'/tasks?status=FAILED&limit=30');
 const safeCodes=String.raw`LLM_UNAVAILABLE|RATE_LIMIT|429|TIMEOUT|ETIMEDOUT|ECONN|EAI_AGAIN|QUOTA|NO_ROUTE|SANDBOX|OOM|OUT_OF_MEMORY|EACCES|PERMISSION|COMMAND_FAILED|TOOL_ERROR|ENOSPC|PROJECT_DIRECTORY|PROJECT_WORKSPACE|NO_MODEL|INVALID_PATH`;
 const failCodes=(Array.isArray(failures)?failures:[]).map(t=>({
   taskId:t.id,updatedAt:t.updated_at,
   hints:[...new Set((String(t.result||'')+' '+String(t.error||'')).toUpperCase().match(new RegExp(safeCodes,'g'))||[])].slice(0,8),
   resultPresent:Boolean(t.result)
 }));
 const tasks=Array.isArray(d.tasks)?d.tasks:[];
 const agentRows=Array.isArray(d.agents)?d.agents:[];
 const counts={};
 for(const t of tasks){const k=String(t.status||'unknown');counts[k]=(counts[k]||0)+1;}
 const ready=(routes.routes||[]).filter(r=>r.eligible);
 const report={villaId:Number(id),observedAt:new Date().toISOString(),
  villa:{status:d.villa?.status,autonomy:d.villa?.autonomy,executing:d.villa?.executing,
   queued:d.queued,openCount:d.villa?.openCount||d.openCount,taskCounts:d.taskCounts||counts,
   unfinishedTasks:tasks.filter(t=>!['DONE','CANCELLED'].includes(t.status)).length,
   taskSummary:tasks.slice(0,30).map(t=>({id:t.id,status:t.status,role:t.role,priority:t.priority,updatedAt:t.updated_at}))},
  agentSummary:{total:agentRows.length,roles:agentRows.map(a=>a.role)},
  failedTasks:failCodes,
  capability:d.capabilityAutopilot?{enabled:d.capabilityAutopilot.enabled,runsWithVilla:d.capabilityAutopilot.runsWithVilla,requests:d.capabilityAutopilot.requests?.map(x=>({id:x.id,status:x.status}))}:null,
  product:{score:product.score,verified:product.verified,blockers:product.blockers,readiness:product.readiness?.checks},
  build:{status:build.status,kind:build.kind,error:build.error,delivery:build.delivery},
  artifact:{verified:deliver.verified,blockers:deliver.blockers},
  scheduler:{active:sched.active,queue:sched.queue,retrying:sched.retrying,concurrency:sched.config?.concurrency,
   focus:sched.focus,blocked:sched.blocked},
  llm:{freeOnly:routes.freeOnly,eligibleCount:ready.length,configuredCount:(routes.routes||[]).filter(r=>r.configured).length,
   eligibleProviderNames:[...new Set(ready.map(r=>r.provider))]},
 };
 return report;
}
if(process.argv[1]?.endsWith('inspect-villa39.mjs')){
 try{
  const result=await inspectVilla({email:process.env.VF_ADMIN_EMAIL,password:process.env.VF_ADMIN_PASSWORD,id:39});
  writeFileSync('villa39-live-diagnostics.json',JSON.stringify(result,null,2)+'\n');
  console.log('Read-only Villa 39 diagnostics saved. Product:',result.product.verified,'Build:',result.build.status);
 }catch(error){writeFileSync('villa39-live-diagnostics.json',JSON.stringify({error:String(error.message||error).slice(0,180)})+'\n');process.exitCode=1;}
}
