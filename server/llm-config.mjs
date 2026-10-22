import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { db } from './db.mjs';
// Only provider configuration is loaded. Never print values or override the service environment.
const allowed=/^(GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY|CEREBRAS_API_KEY|MISTRAL_API_KEY|XAI_API_KEY|HF_TOKEN|HUGGINGFACE_API_KEY|OLLAMA_API_KEY|VF_(?:LLM_.*|LOCAL_LLM_.*|GEMINI_MODEL|GROQ_MODEL|CEREBRAS_MODEL|MISTRAL_MODEL|XAI_MODEL|HF_MODEL))$/;
for(const path of [resolve('.env'),resolve('server/.env')]) {
  if(!existsSync(path)) continue;
  try { for(const [key,value] of Object.entries(parseEnv(readFileSync(path,'utf8')))) if(allowed.test(key)&&process.env[key]==null) process.env[key]=value; } catch { /* invalid optional file; service configuration still applies */ }
}
export const KEY_ALIASES={GEMINI_API_KEY:['GOOGLE_API_KEY'],HF_TOKEN:['HUGGINGFACE_API_KEY']};
const configuredGroqModel=process.env.VF_GROQ_MODEL==='llama-3.3-70b-versatile'?'openai/gpt-oss-120b':(process.env.VF_GROQ_MODEL||'openai/gpt-oss-120b');
export function cascadeDefaults() {
 return [
  ['Gemini','gemini','https://generativelanguage.googleapis.com/v1beta/openai',process.env.VF_GEMINI_MODEL||'gemini-3.5-flash-lite','GEMINI_API_KEY',10],
  ['Cerebras','cerebras','https://api.cerebras.ai/v1',process.env.VF_CEREBRAS_MODEL||'gpt-oss-120b','CEREBRAS_API_KEY',12],
  ['Groq','groq','https://api.groq.com/openai/v1',configuredGroqModel,'GROQ_API_KEY',20],
  ['Mistral','mistral','https://api.mistral.ai/v1',process.env.VF_MISTRAL_MODEL||'mistral-small-latest','MISTRAL_API_KEY',21],
  ['OpenRouter Free','openrouter','https://openrouter.ai/api/v1','openrouter/free','OPENROUTER_API_KEY',22],
  // xAI is opt-in: it is not a free tier and must not silently incur charges.
  ...(process.env.VF_XAI_MODEL ? [['xAI','xai','https://api.x.ai/v1',process.env.VF_XAI_MODEL,'XAI_API_KEY',21]]:[]),
  ['Hugging Face','huggingface','https://router.huggingface.co/v1',process.env.VF_HF_MODEL||'auto','HF_TOKEN',30],
  ['Ollama local','ollama',process.env.VF_LOCAL_LLM_URL||'http://127.0.0.1:11434/v1',process.env.VF_LOCAL_LLM_MODEL||'auto','',40],
  ['Local reserve','lmstudio',process.env.VF_LOCAL_LLM_SECONDARY_URL||'http://127.0.0.1:1234/v1',process.env.VF_LOCAL_LLM_SECONDARY_MODEL||'auto','',41],
  // Opt-in self-hosted OpenAI-compatible endpoints. Configure URLs via server environment.
  ...(process.env.VF_LLM_ORACLE_URL ? [['Oracle self-hosted','ollama',process.env.VF_LLM_ORACLE_URL,process.env.VF_LLM_ORACLE_MODEL||'auto',process.env.VF_LLM_ORACLE_API_KEY?'VF_LLM_ORACLE_API_KEY':'',42]]:[]),
  ...(process.env.VF_LLM_HETZNER_URL ? [['Hetzner self-hosted','ollama',process.env.VF_LLM_HETZNER_URL,process.env.VF_LLM_HETZNER_MODEL||'auto',process.env.VF_LLM_HETZNER_API_KEY?'VF_LLM_HETZNER_API_KEY':'',43]]:[])
 ].map(([name,provider,base_url,model,key_env,priority])=>({name:`Cascade: ${name}`,provider,base_url,model,key_env,priority}));
}
export function syncCascadeRoutes() {
 let added=0;
 for(const r of cascadeDefaults()) {
  // Existing rows (including disabled rows) are an administrator decision.
  const existing=db.prepare('SELECT id,name,model FROM routes WHERE name=? OR (base_url=? AND model=?)').get(r.name,r.base_url,r.model);
  if(existing){
   const names={'Cascade: Gemini':['VF_GEMINI_MODEL'],'Cascade: Cerebras':['VF_CEREBRAS_MODEL'],'Cascade: Groq':['VF_GROQ_MODEL'],'Cascade: Mistral':['VF_MISTRAL_MODEL'],'Cascade: Hugging Face':['VF_HF_MODEL'],'Cascade: xAI':['VF_XAI_MODEL'],'Cascade: Ollama local':['VF_LOCAL_LLM_URL','VF_LOCAL_LLM_MODEL'],'Cascade: Local reserve':['VF_LOCAL_LLM_SECONDARY_URL','VF_LOCAL_LLM_SECONDARY_MODEL'],'Cascade: Oracle self-hosted':['VF_LLM_ORACLE_URL','VF_LLM_ORACLE_MODEL'],'Cascade: Hetzner self-hosted':['VF_LLM_HETZNER_URL','VF_LLM_HETZNER_MODEL']};
   const staleDefault=(r.name==='Cascade: Gemini'&&['auto','gemini-2.0-flash'].includes(existing.model)&&!process.env.VF_GEMINI_MODEL)||(r.name==='Cascade: Cerebras'&&existing.model==='llama-3.3-70b'&&!process.env.VF_CEREBRAS_MODEL)||(r.name==='Cascade: Groq'&&existing.model==='llama-3.3-70b-versatile'&&(!process.env.VF_GROQ_MODEL||process.env.VF_GROQ_MODEL==='llama-3.3-70b-versatile'));
   if(existing.name===r.name&&((names[r.name]||[]).some(k=>process.env[k])||staleDefault))db.prepare('UPDATE routes SET base_url=?,model=? WHERE id=?').run(r.base_url,r.model,existing.id);
   continue;
  }
  db.prepare('INSERT INTO routes(name,provider,base_url,model,key_env,priority) VALUES (?,?,?,?,?,?)').run(r.name,r.provider,r.base_url,r.model,r.key_env,r.priority);added++;
 }
 return {added};
}
export function isLocalRoute(r) {return ['ollama','lmstudio'].includes(r.provider)||/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(r.base_url||'');}
/** Cost-safe default: unknown and credit-based cloud providers are opt-in. */
export function isFreeRoute(r) {
 if(isLocalRoute(r)) return true;
 const provider=String(r.provider||'').toLowerCase();
 const model=String(r.model||'').toLowerCase();
 if(provider==='gemini'||provider==='gemini-openai') return model==='gemini-3.5-flash-lite';
 if(provider==='openrouter') return model==='openrouter/free'||model.endsWith(':free');
 if(provider==='groq') return ['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.8-27b'].includes(model);
 if(provider==='cerebras') return ['gpt-oss-120b','qwen-3.8-27b'].includes(model);
 if(provider==='mistral') return model==='mistral-small-latest';
 return false;
}
export function freeOnlyEnabled() {return !['0','false','off','no'].includes(String(process.env.VF_LLM_FREE_ONLY||'1').toLowerCase());}
export function routeTier(r) {
 if(isLocalRoute(r)) return 6;
 const p=String(r.provider+' '+r.base_url).toLowerCase();
 if(/gemini|generativelanguage/.test(p)) return 1;
 if(/cerebras/.test(p)) return 2;
 if(/groq/.test(p)) return 3;
 if(/mistral/.test(p)) return 4;
 if(/openrouter/.test(p)) return 4;
 if(/huggingface|router\.huggingface/.test(p)) return 5;
 return 5;
}
