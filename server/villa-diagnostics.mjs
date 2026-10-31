import {db} from './db.mjs';
import {assessVillaConfiguration} from './villa-configuration.mjs';
import {toolSpecs} from './agents.mjs';
import {maturity} from './product.mjs';
import {mediaCapabilities} from './media.mjs';
export function villaDiagnostics(){
 const tools=toolSpecs(),villas=db.prepare('SELECT * FROM villas ORDER BY id').all();
 const reports=villas.map(villa=>{
  const agents=db.prepare('SELECT id,role,is_root,system_prompt FROM agents WHERE villa_id=? ORDER BY id').all(villa.id);
  const taskCounts=Object.fromEntries(db.prepare('SELECT status,COUNT(*) c FROM tasks WHERE villa_id=? GROUP BY status').all(villa.id).map(r=>[r.status,r.c]));
  const proposal=db.prepare("SELECT items FROM villa_proposals WHERE villa_id=? AND kind='prompt_agent' AND status='ready' ORDER BY id DESC LIMIT 1").get(villa.id);
  let missionAvailable=false;try{missionAvailable=typeof JSON.parse(proposal?.items||'{}').mission_prompt==='string';}catch{}
  return assessVillaConfiguration({villa,agents,taskCounts,tools,product:maturity(villa.id),missionAvailable});
 });
 return {schemaVersion:1,readOnly:true,generatedAt:new Date().toISOString(),villas:reports,media:mediaCapabilities().map(c=>({id:c.id,status:c.status,executionVerified:false})),summary:{total:reports.length,blocked:reports.filter(r=>r.status==='blocked').length,needsReview:reports.filter(r=>r.status==='needs_review').length,passed:reports.filter(r=>r.status==='passed').length}};
}
