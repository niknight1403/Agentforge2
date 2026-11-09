import { resolve, relative, sep } from 'node:path';

export const GENERATION_STREAM = process.env.AGENTFORGE_GENERATION_STREAM || 'agentforge:events:stream';
export const GENERATION_GROUP = process.env.AGENTFORGE_GENERATION_GROUP || 'fullstack-generation-v1';
export const MAX_GENERATED_FILES = 80;
export const MAX_GENERATED_BYTES = 1_500_000;

export function safeGeneratedPath(value) {
  const input=String(value||'').replaceAll('\\','/');
  if(!input || input.length>240 || input.startsWith('/') || /^[a-zA-Z]:/.test(input) || input.includes('\0')) return null;
  const normalized=resolve('/workspace',input);
  const rel=relative('/workspace',normalized);
  if(!rel || rel==='.' || rel==='..' || rel.startsWith('..'+sep)) return null;
  if(rel.split(sep).some(part=>!part || part==='.' || part==='..' || part.startsWith('.git'))) return null;
  return rel.split(sep).join('/');
}

export function parseGenerationOutput(raw) {
  const text=String(raw||'').trim();
  let parsed;
  try { parsed=JSON.parse(text); } catch { throw Object.assign(new Error('LLM_OUTPUT_INVALID_JSON'),{code:'LLM_OUTPUT_INVALID_JSON'}); }
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('Manifest muss ein Objekt sein.');
  const files=Array.isArray(parsed.files)?parsed.files:[];
  if(files.length<1 || files.length>MAX_GENERATED_FILES) throw new Error('GENERATED_FILE_COUNT_INVALID');
  let bytes=0;
  const seen=new Set();
  const normalized=files.map(file=>{
    const path=safeGeneratedPath(file?.path);
    if(!path || seen.has(path)) throw new Error('GENERATED_PATH_INVALID_OR_DUPLICATE');
    seen.add(path);
    if(typeof file.content!=='string') throw new Error('GENERATED_FILE_CONTENT_INVALID');
    bytes+=Buffer.byteLength(file.content,'utf8');
    return {path,content:file.content};
  });
  if(bytes>MAX_GENERATED_BYTES) throw new Error('GENERATED_OUTPUT_TOO_LARGE');
  const manifest={
    name:String(parsed.name||'Generated application').slice(0,120),
    description:String(parsed.description||'').slice(0,500),
    stack:Array.isArray(parsed.stack)?parsed.stack.map(x=>String(x).slice(0,80)).slice(0,12):[],
    commands:Array.isArray(parsed.commands)?parsed.commands.map(x=>String(x).slice(0,120)).slice(0,8):[],
    acceptance:Array.isArray(parsed.acceptance)?parsed.acceptance.map(x=>String(x).slice(0,240)).slice(0,12):[],
    files:normalized.map(({path})=>path)
  };
  return {manifest,files:normalized,bytes};
}

export function generationPrompt(prompt, previousFailure='') {
  return [
    'Du bist ein sicherheitsbewusster Full-Stack-Staff-Engineer. Erzeuge ein kleines, vollständiges, startbares Softwareprojekt.',
    'Antworte ausschließlich als valides JSON-Objekt ohne Markdown mit: name, description, stack (string[]), commands (string[]), acceptance (string[]), files (Array aus {path,content}).',
    'Erzeuge Frontend und Backend modular, API-Verträge, persistentes Datenmodell (Prisma schema falls sinnvoll), RBAC/Auth mit sicheren Defaults und Tests. Bevorzuge React/Vite + Node/Express + Prisma/PostgreSQL, passe den Stack aber der Aufgabe an.',
    'Keine Secrets, keine echten Zugangsdaten, keine Shell-Skripte, keine postinstall/preinstall/install-Skripte, keine Downloads oder Netzwerkaufrufe während Tests.',
    'Keine Pfade außerhalb des Projekts, keine Symlinks, keine Binärdateien. Begrenze dich auf maximal 80 Textdateien.',
    'Lege package.json mit build/test Skripten an, aber führe keine Paketinstallation aus. Verwende nur notwendige Abhängigkeiten und dokumentiere Voraussetzungen.',
    previousFailure ? 'REVIEW-FEEDBACK: '+String(previousFailure).slice(0,1200)+' Bitte korrigiere die vorige Ausgabe.' : '',
    'NUTZERANFORDERUNG:\n'+String(prompt||'').slice(0,9000)
  ].filter(Boolean).join('\n\n');
}

export function generationEvent(type, taskId, metadata={}) {
  const safe={};
  for(const [key,value] of Object.entries(metadata)) {
    if(value==null) continue;
    if(typeof value==='string') safe[key]=value.slice(0,180);
    else if(typeof value==='number' && Number.isFinite(value)) safe[key]=value;
    else if(typeof value==='boolean') safe[key]=value;
  }
  return {type,taskId:String(taskId||'').slice(0,100),at:Date.now(),...safe};
}
