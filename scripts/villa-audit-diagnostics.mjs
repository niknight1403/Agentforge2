import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const CHECK_CODES=new Set([
 'agent_prompts',
 'artifact_secrets',
 'audit_fetch',
 'completion_consistency',
 'delivery_team',
 'development_tools',
 'product_acceptance',
 'project_brief',
 'project_mission',
 'prompt_contract',
 'role_catalog',
 'root_agent',
 'spion_observation',
 'taste_profile'
]);
const CHECK_STATUSES=new Set(['pass','blocked','warning']);

function invalidReport(){
 return Object.assign(new Error('AUDIT_REPORT_INVALID'),{code:'AUDIT_REPORT_INVALID'});
}

export function aggregateAuditCheckCounts(report){
 if(!report||typeof report!=='object'||Array.isArray(report)||!Array.isArray(report.villas))throw invalidReport();
 const counts=new Map();
 for(const villa of report.villas){
  if(!villa||typeof villa!=='object'||Array.isArray(villa)||!Array.isArray(villa.checks)||villa.checks.length===0)throw invalidReport();
  for(const check of villa.checks){
   if(!check||typeof check!=='object'||Array.isArray(check)||typeof check.code!=='string'||!check.code||typeof check.status!=='string'||!check.status)throw invalidReport();
   const code=CHECK_CODES.has(check.code)?check.code:'other';
   const status=CHECK_STATUSES.has(check.status)?check.status:'other';
   const key=code+'\0'+status;
   counts.set(key,(counts.get(key)||0)+1);
  }
 }
 return [...counts].map(([key,count])=>{
  const [code,status]=key.split('\0');
  return {code,status,count};
 }).sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:a.status<b.status?-1:a.status>b.status?1:0);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const report=JSON.parse(readFileSync(process.argv[2]||'artifacts/villa-configuration/report.json','utf8'));
  console.log('Villa audit check counts: '+JSON.stringify(aggregateAuditCheckCounts(report)));
 }catch{
  console.error('Villa audit diagnostics failed (AUDIT_REPORT_INVALID). No report content was logged.');
  process.exitCode=1;
 }
}
