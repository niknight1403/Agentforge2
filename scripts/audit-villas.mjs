/** Authenticated read-only production audit; outputs findings, never raw prompts or credentials. */
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessVillaConfiguration} from '../server/villa-configuration.mjs';
export async function auditLiveVillas({baseUrl,email,password,fetchImpl=fetch}={}){
 const u=new URL(baseUrl);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Audit requires an HTTPS origin.');
 if(!email||!password)throw Error('Audit credentials missing.');
 const overall=AbortSignal.timeout(300000);let token;
 async function request(path,body){
  const r=await fetchImpl(u.origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([overall,AbortSignal.timeout(15000)])});
  if(!r.ok)throw Error('Audit endpoint '+path+' HTTP '+r.status);
  const text=await r.text();if(text.length>12*1024*1024)throw Error('Audit response too large.');return JSON.parse(text);
 }
 token=(await request('/api/auth/login',{email,password})).token;if(!token)throw Error('Audit login did not return a session.');
 const health=await request('/api/health'),listed=await request('/api/villas');
 const villas=Array.isArray(listed)?listed:listed.villas;if(!Array.isArray(villas)||villas.length>500)throw Error('Villa inventory invalid or exceeds bounded audit capacity.');
 const catalog=await request('/api/control/catalog'),rawTools=await request('/api/tools'),tools=Array.isArray(rawTools)?rawTools:rawTools.tools;
 if(!Array.isArray(tools))throw Error('Tool inventory invalid.');
 const routes=await request('/api/llm/status'),reports=[];
 let media=[];
 if(villas.length){try{const out=await request('/api/mcp',{jsonrpc:'2.0',id:'capability-audit',method:'tools/call',params:{name:'media_capabilities',arguments:{villa_id:Number(villas[0].id)}}});const data=JSON.parse(out.result?.content?.[0]?.text||'null');if(Array.isArray(data))media=data.map(c=>({id:c.id,status:c.status,executionVerified:false}));}catch{}}
 for(const v of villas){
  const id=Number(v.id);if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid Villa ID.');
  try{
   const detail=await request('/api/villas/'+id),product=await request('/api/villas/'+id+'/product'),evolution=await request('/api/evolution/villas/'+id);
   const missionAvailable=(evolution.proposals||[]).some(p=>p.kind==='prompt_agent'&&p.status==='ready');
   reports.push(assessVillaConfiguration({villa:detail.villa,agents:detail.agents,taskCounts:detail.taskCounts,tools,product,missionAvailable}));
  }catch{reports.push({villaId:id,status:'unavailable',checks:[{code:'audit_fetch',status:'blocked',detail:'Villa-Daten konnten nicht vollstaendig gelesen werden.',nextStep:'Berechtigung, Endpoint und Erreichbarkeit pruefen.'}]});}
 }
 return {schemaVersion:1,generatedAt:new Date().toISOString(),source:{kind:'production-http',version:health.version,testFixture:health.testFixture===true},readOnly:true,complete:reports.length===villas.length&&!reports.some(v=>v.status==='unavailable'),summary:{total:villas.length,passed:reports.filter(v=>v.status==='passed').length,needsReview:reports.filter(v=>v.status==='needs_review').length,blocked:reports.filter(v=>v.status==='blocked').length,unavailable:reports.filter(v=>v.status==='unavailable').length},integrations:{media,mediaInspection:media.length?'configuration_only':'unavailable',packs:(catalog.packs?.tools||[]).map(p=>({id:p.id,enabled:p.enabled,effective:p.effective})),skills:(catalog.skills||[]).map(s=>({id:s.id,enabled:!!s.enabled})),connectors:(catalog.connectors||[]).map(c=>({id:c.id,enabled:!!c.enabled,status:c.last_status,executionVerified:false})),llm:{configured:(routes.routes||[]).filter(r=>r.configured).length,eligible:(routes.routes||[]).filter(r=>r.eligible).length,freeOnly:routes.freeOnly,realAnswerVerified:false}},villas:reports};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const path=resolve(process.env.VF_AUDIT_OUTPUT||'artifacts/villa-configuration/report.json');
 try{const report=await auditLiveVillas({baseUrl:process.env.VF_AUDIT_BASE_URL||'https://hub.cybersarah-ki.com',email:process.env.VF_ADMIN_EMAIL,password:process.env.VF_ADMIN_PASSWORD});mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({source:report.source,summary:report.summary,complete:report.complete}));process.exitCode=report.complete&&!report.summary.blocked&&!report.summary.needsReview&&!report.source.testFixture?0:1;}
 catch{console.error('Villa audit could not complete. No credentials or raw response were logged.');process.exitCode=2;}
}
