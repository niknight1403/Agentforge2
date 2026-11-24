import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { db } from './db.mjs';
import { FREE_ROUTE_CATALOG } from './routes.mjs';
// Only provider configuration is loaded. Never print values or override the service environment.
const allowed=/^(GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY|CEREBRAS_API_KEY|MISTRAL_API_KEY|XAI_API_KEY|HF_TOKEN|HUGGINGFACE_API_KEY|OLLAMA_API_KEY|FAL_KEY|VF_(?:LLM_.*|LOCAL_LLM_.*|RPM_.*|SELF_HOSTED_ALLOWED_HOSTS|GEMINI_MODEL|GROQ_MODEL|CEREBRAS_MODEL|MISTRAL_MODEL|XAI_MODEL|XAI_TIMEOUT_MS|HF_MODEL|FAL_.*|MEDIA_MAX_BYTES))$/;
for(const path of (process.env.VF_TEST==='1'?[]:[resolve('.env'),resolve('server/.env')])) {
  if(!existsSync(path)) continue;
  try { for(const [key,value] of Object.entries(parseEnv(readFileSync(path,'utf8')))) if(allowed.test(key)&&process.env[key]==null) process.env[key]=value; } catch { /* invalid optional file; service configuration still applies */ }
}
export const KEY_ALIASES={GEMINI_API_KEY:['GOOGLE_API_KEY'],HF_TOKEN:['HUGGINGFACE_API_KEY']};
const configuredGroqModel=process.env.VF_GROQ_MODEL==='llama-3.3-70b-versatile'?'openai/gpt-oss-120b':(process.env.VF_GROQ_MODEL||'openai/gpt-oss-120b');
export function cascadeDefaults() {
 return [
  ['Gemini','gemini','https://generativelanguage.googleapis.com/v1beta/openai',process.env.VF_GEMINI_MODEL||'gemini-3.1-flash-lite','GEMINI_API_KEY',10],
  ['Cerebras','cerebras','https://api.cerebras.ai/v1',process.env.VF_CEREBRAS_MODEL||'gpt-oss-120b','CEREBRAS_API_KEY',12],
  ['Groq','groq','https://api.groq.com/openai/v1',configuredGroqModel,'GROQ_API_KEY',20],
  ['Mistral','mistral','https://api.mistral.ai/v1',process.env.VF_MISTRAL_MODEL||'mistral-small-latest','MISTRAL_API_KEY',21],
  ['OpenRouter Free','openrouter','https://openrouter.ai/api/v1','openrouter/free','OPENROUTER_API_KEY',22],
  // xAI is opt-in: it is not a free tier and must not silently incur charges.
  ...(process.env.VF_XAI_MODEL ? [['xAI','xai','https://api.x.ai/v1',process.env.VF_XAI_MODEL,'XAI_API_KEY',21]]:[]),
  ['Hugging Face','huggingface','https://router.huggingface.co/v1',process.env.VF_HF_MODEL||'openai/gpt-oss-120b:cerebras','HF_TOKEN',30],
  ['Ollama local','ollama',process.env.VF_LOCAL_LLM_URL||'http://127.0.0.1:11434/v1',process.env.VF_LOCAL_LLM_MODEL||'auto','',40],
  ['Local reserve','lmstudio',process.env.VF_LOCAL_LLM_SECONDARY_URL||'http://127.0.0.1:1234/v1',process.env.VF_LOCAL_LLM_SECONDARY_MODEL||'auto','',41]
 ].map(([name,provider,base_url,model,key_env,priority])=>({name:`Cascade: ${name}`,provider,base_url,model,key_env,priority}));
}
/**
 * Idempotently add missing provider-catalog entries. Existing route rows are
 * administrator decisions and are never re-enabled or overwritten on upgrade.
 * Paid/credit-based routes are inserted disabled; only centrally verified
 * free/local routes are enabled by default.
 */
export function seedRouteCatalog() {
 let seeded = 0;
 const insert = db.prepare(
  'INSERT INTO routes (name,provider,base_url,model,key_env,is_free,enabled,priority,weight,status,ok,fail,last_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
 );
 const exists = db.prepare('SELECT id FROM routes WHERE name=? OR (base_url=? AND model=?)');
 for (const catalogRoute of FREE_ROUTE_CATALOG) {
  const route = catalogRoute.provider === 'xai'
    ? { ...catalogRoute, model: process.env.VF_XAI_MODEL || catalogRoute.model }
    : catalogRoute;
  if (exists.get(route.name, route.baseUrl, route.model)) continue;
  const free = Number(isFreeRoute({ provider: route.provider, base_url: route.baseUrl, model: route.model }));
  insert.run(route.name, route.provider, route.baseUrl, route.model, route.keyEnv, free, free, route.priority, 1, 'NEW', 0, 0, 0);
  seeded += 1;
 }
 return { seeded };
}

export function syncCascadeRoutes() {
 let added=0;
 for(const r of cascadeDefaults()) {
  // Existing rows (including disabled rows) are an administrator decision.
  const existing=db.prepare('SELECT id,name,model FROM routes WHERE name=? OR (base_url=? AND model=?)').get(r.name,r.base_url,r.model);
  if(existing){
   const names={'Cascade: Gemini':['VF_GEMINI_MODEL'],'Cascade: Cerebras':['VF_CEREBRAS_MODEL'],'Cascade: Groq':['VF_GROQ_MODEL'],'Cascade: Mistral':['VF_MISTRAL_MODEL'],'Cascade: Hugging Face':['VF_HF_MODEL'],'Cascade: xAI':['VF_XAI_MODEL'],'Cascade: Ollama local':['VF_LOCAL_LLM_URL','VF_LOCAL_LLM_MODEL'],'Cascade: Local reserve':['VF_LOCAL_LLM_SECONDARY_URL','VF_LOCAL_LLM_SECONDARY_MODEL']};
   const staleDefault=(r.name==='Cascade: Gemini'&&['auto','gemini-2.0-flash','gemini-3.5-flash-lite'].includes(existing.model)&&!process.env.VF_GEMINI_MODEL)||(r.name==='Cascade: Cerebras'&&existing.model==='llama-3.3-70b'&&!process.env.VF_CEREBRAS_MODEL)||(r.name==='Cascade: Groq'&&existing.model==='llama-3.3-70b-versatile'&&(!process.env.VF_GROQ_MODEL||process.env.VF_GROQ_MODEL==='llama-3.3-70b-versatile'));
   if(existing.name===r.name&&((names[r.name]||[]).some(k=>process.env[k])||staleDefault))db.prepare('UPDATE routes SET base_url=?,model=? WHERE id=?').run(r.base_url,r.model,existing.id);
   continue;
  }
  const free = Number(isFreeRoute(r));
  db.prepare('INSERT INTO routes(name,provider,base_url,model,key_env,is_free,enabled,priority,weight,status,ok,fail,last_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(r.name,r.provider,r.base_url,r.model,r.key_env,free,free,r.priority,1,'NEW',0,0,0);
  added++;
 }
 return {added};
}
export function syncFreeRouteFlags() {
 let updated=0;
 for(const row of db.prepare('SELECT id,provider,base_url,model,is_free FROM routes').all()) {
  const free=Number(isFreeRoute(row));
  if(Number(row.is_free)!==free) {db.prepare('UPDATE routes SET is_free=? WHERE id=?').run(free,row.id);updated++;}
 }
 return {updated};
}
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export function isLocalRoute(r) {
 try {
  const url = new URL(r?.base_url || '');
  return ['http:', 'https:'].includes(url.protocol) && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
 } catch { return false; }
}
export function isTrustedSelfHostedRoute(r) {
 if (!['ollama', 'lmstudio'].includes(String(r?.provider || '').toLowerCase())) return false;
 let url;
 try { url = new URL(r?.base_url || ''); } catch { return false; }
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
 const trusted = String(process.env.VF_SELF_HOSTED_ALLOWED_HOSTS || '')
  .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
 return trusted.includes(url.hostname.toLowerCase());
}
/** Infer known provider families for manually-added OpenAI-compatible endpoints. */
export function routeProvider(r) {
 const declared=String(r?.provider||'').toLowerCase();
 if(declared&&declared!=='openai-compatible')return declared;
 let host='';try{host=new URL(r?.base_url||'').hostname.toLowerCase();}catch{}
 if(host==='generativelanguage.googleapis.com')return 'gemini-openai';
 if(host==='api.groq.com')return 'groq';
 if(host==='openrouter.ai')return 'openrouter';
 if(host==='api.cerebras.ai')return 'cerebras';
 if(host==='api.mistral.ai')return 'mistral';
 if(host==='router.huggingface.co')return 'huggingface';
 if(host==='api.x.ai')return 'xai';
 return declared||'openai-compatible';
}
/** Cost-safe default: unknown and credit-based cloud providers are opt-in. */
export function isFreeRoute(r) {
 if(isLocalRoute(r)) return true;
 const provider=routeProvider(r);
 if(provider==='ollama'||provider==='lmstudio') return isTrustedSelfHostedRoute(r);
 const model=String(r.model||'').toLowerCase();
 if(provider==='gemini'||provider==='gemini-openai') return model==='gemini-3.1-flash-lite';
 if(provider==='openrouter') return model==='openrouter/free'||model.endsWith(':free');
 if(provider==='groq') return ['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.8-27b'].includes(model);
 // Pollinations generation now requires authentication and may consume balance.
 if(provider==='pollinations') return false;
 // Cerebras currently provides expiring trial credits, not a renewable free tier.
 // Hugging Face free accounts have no included inference-provider credits.
 return false;
}
export function freeOnlyEnabled() {return !['0','false','off','no'].includes(String(process.env.VF_LLM_FREE_ONLY||'1').toLowerCase());}
export function routeTier(r) {
 if(isLocalRoute(r)||isTrustedSelfHostedRoute(r)) return 6;
 const p=String(routeProvider(r)+' '+r.base_url).toLowerCase();
 if(/gemini|generativelanguage/.test(p)) return 1;
 if(/cerebras/.test(p)) return 2;
 if(/groq/.test(p)) return 3;
 if(/mistral/.test(p)) return 4;
 if(/openrouter/.test(p)) return 4;
 if(/huggingface|router\.huggingface/.test(p)) return 5;
 return 5;
}
