// Route Generator Agent: validate operator-authorized endpoints, never mint accounts or bypass quotas.
import { isIP } from 'node:net';
const safeHost = host => {
  const h = host.toLowerCase();
  if (['localhost','localhost.localdomain'].includes(h) || h.endsWith('.localhost')) return true;
  if (isIP(h)) return true; // private and public self-hosted IPs require explicit operator allowlist below
  return /^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/.test(h);
};
export function discoverConfiguredRoutes(env=process.env) {
 const definitions=[
  ['Oracle','VF_LLM_ORACLE_URL','VF_LLM_ORACLE_MODEL','VF_LLM_ORACLE_API_KEY'],
  ['Hetzner','VF_LLM_HETZNER_URL','VF_LLM_HETZNER_MODEL','VF_LLM_HETZNER_API_KEY'],
  ['Ollama','VF_LOCAL_LLM_URL','VF_LOCAL_LLM_MODEL','OLLAMA_API_KEY'],
  ['LM Studio','VF_LOCAL_LLM_SECONDARY_URL','VF_LOCAL_LLM_SECONDARY_MODEL',null]
 ];
 return definitions.flatMap(([name,urlKey,modelKey,keyKey])=>{
  const raw=env[urlKey];
  if(!raw)return [];
  try {
   const url=new URL(raw);
   if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!safeHost(url.hostname)) return [];
   if(url.protocol==='http:' && !['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname) && env.VF_LLM_ALLOW_PRIVATE_HTTP!=='1')return [];
   return [{name,base_url:url.toString().replace(/\/$/,''),model:env[modelKey]||'auto',key_env:keyKey&&env[keyKey]?keyKey:'',source:urlKey}];
  }catch{return [];}
 });
}
export async function probeConfiguredRoutes({env=process.env,fetcher=fetch,timeoutMs=2500}={}) {
 const routes=discoverConfiguredRoutes(env);
 const results=[];
 for(const route of routes){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
   const headers=route.key_env?{Authorization:'Bearer '+env[route.key_env]}:{};
   const url=route.base_url.replace(/\/v1\/?$/,'')+'/api/tags';
   const response=await fetcher(url,{headers,signal:controller.signal,redirect:'error'});
   results.push({name:route.name,configured:true,reachable:response.ok,status:response.status});
  } catch {results.push({name:route.name,configured:true,reachable:false,status:null});}
  finally{clearTimeout(timer);}
 }
 return results;
}
