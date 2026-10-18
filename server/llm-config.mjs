import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { db } from './db.mjs';
// Only provider configuration is loaded. Never print values or override the service environment.
const allowed=/^(GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY|XAI_API_KEY|HF_TOKEN|HUGGINGFACE_API_KEY|OLLAMA_API_KEY|VF_(?:LLM_.*|LOCAL_LLM_.*|GEMINI_MODEL|GROQ_MODEL|XAI_MODEL|HF_MODEL))$/;
for(const path of [resolve('.env'),resolve('server/.env')]) {
  if(!existsSync(path)) continue;
  try { for(const [key,value] of Object.entries(parseEnv(readFileSync(path,'utf8')))) if(allowed.test(key)&&process.env[key]==null) process.env[key]=value; } catch { /* invalid optional file; service configuration still applies */ }
}
export const KEY_ALIASES={GEMINI_API_KEY:['GOOGLE_API_KEY'],HF_TOKEN:['HUGGINGFACE_API_KEY']};
export function cascadeDefaults() {
 return [
  ['Gemini','gemini','https://generativelanguage.googleapis.com/v1beta/openai',process.env.VF_GEMINI_MODEL||'auto','GEMINI_API_KEY',10],
  ['OpenRouter Free','openrouter','https://openrouter.ai/api/v1','openrouter/free','OPENROUTER_API_KEY',11],
  ['Groq','groq','https://api.groq.com/openai/v1',process.env.VF_GROQ_MODEL||'llama-3.3-70b-versatile','GROQ_API_KEY',20],
  // xAI is opt-in: it is not a free tier and must not silently incur charges.
  ...(process.env.VF_XAI_MODEL ? [['xAI','xai','https://api.x.ai/v1',process.env.VF_XAI_MODEL,'XAI_API_KEY',21]]:[]),
  ['Hugging Face','huggingface','https://router.huggingface.co/v1',process.env.VF_HF_MODEL||'auto','HF_TOKEN',30],
  ['Ollama local','ollama',process.env.VF_LOCAL_LLM_URL||'http://127.0.0.1:11434/v1',process.env.VF_LOCAL_LLM_MODEL||'auto','',40],
  ['Local reserve','lmstudio',process.env.VF_LOCAL_LLM_SECONDARY_URL||'http://127.0.0.1:1234/v1',process.env.VF_LOCAL_LLM_SECONDARY_MODEL||'auto','',41]
 ].map(([name,provider,base_url,model,key_env,priority])=>({name:`Cascade: ${name}`,provider,base_url,model,key_env,priority}));
}
export function syncCascadeRoutes() {
 let added=0;
 for(const r of cascadeDefaults()) {
  // Existing rows (including disabled rows) are an administrator decision.
  const existing=db.prepare('SELECT id,name FROM routes WHERE name=? OR (base_url=? AND model=?)').get(r.name,r.base_url,r.model);
  if(existing){
   const names={'Cascade: Gemini':['VF_GEMINI_MODEL'],'Cascade: Groq':['VF_GROQ_MODEL'],'Cascade: Hugging Face':['VF_HF_MODEL'],'Cascade: xAI':['VF_XAI_MODEL'],'Cascade: Ollama local':['VF_LOCAL_LLM_URL','VF_LOCAL_LLM_MODEL'],'Cascade: Local reserve':['VF_LOCAL_LLM_SECONDARY_URL','VF_LOCAL_LLM_SECONDARY_MODEL']};
   if(existing.name===r.name&&(names[r.name]||[]).some(k=>process.env[k]))db.prepare('UPDATE routes SET base_url=?,model=? WHERE id=?').run(r.base_url,r.model,existing.id);
   continue;
  }
  db.prepare('INSERT INTO routes(name,provider,base_url,model,key_env,priority) VALUES (?,?,?,?,?,?)').run(r.name,r.provider,r.base_url,r.model,r.key_env,r.priority);added++;
 }
 return {added};
}
export function isLocalRoute(r) {return ['ollama','lmstudio'].includes(r.provider)||/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(r.base_url||'');}
export function routeTier(r) {
 if(isLocalRoute(r)) return 4;
 const p=String(r.provider+' '+r.base_url).toLowerCase();
 if(/gemini|generativelanguage|openrouter/.test(p)) return 1;
 if(/groq|xai|api\.x\.ai/.test(p)) return 2;
 return 3;
}
