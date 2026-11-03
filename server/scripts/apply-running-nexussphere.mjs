#!/usr/bin/env node
// Safe NexusSphere handoff to an already approved and linked villa.
// Dry run by default; requires VF_DB and explicit --apply for writes.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function findNexusSphere(db) {
  const rows=db.prepare("SELECT id,title,proposed_name,masterprompt,status,villa_id FROM proposals WHERE lower(trim(proposed_name))='nexussphere' OR lower(trim(title))='nexussphere' ORDER BY id").all();
  if(rows.length!==1) throw Error('Expected exactly one NexusSphere proposal, found '+rows.length);
  const proposal=rows[0];
  if(proposal.status!=='approved'||!Number.isSafeInteger(proposal.villa_id)||proposal.villa_id<1) throw Error('NexusSphere proposal has no verified approved villa');
  const villa=db.prepare('SELECT id,name,idea,status FROM villas WHERE id=?').get(proposal.villa_id);
  if(!villa||villa.name.trim().toLowerCase()!=='nexussphere'||villa.status==='ARCHIVED') throw Error('Linked active NexusSphere villa missing or name mismatch');
  const roots=db.prepare('SELECT id,system_prompt FROM agents WHERE villa_id=? AND is_root=1').all(villa.id);
  if(roots.length!==1) throw Error('Expected exactly one root agent, found '+roots.length);
  return {proposal,villa,root:roots[0]};
}

export function updateRunningVilla(db,master,{apply=false,backupPath=null}={}) {
  const {proposal,villa,root}=findNexusSphere(db);
  if(master.trim().length<500||!proposal.masterprompt?.trim()) throw Error('Missing master prompt or original proposal');
  const handoff=master.trim()+'\n\n---\n\n# Unveränderter ursprünglicher NexusSphere-Projektauftrag\n\n'+proposal.masterprompt.trim();
  const title='NexusSphere: verifizierter Projektabschluss';
  const existing=db.prepare('SELECT content FROM memories WHERE villa_id=? AND kind=? AND title=?').all(villa.id,'CONSTRAINT',title);
  const info={villaId:villa.id,villaName:villa.name,villaStatus:villa.status,proposalId:proposal.id,sha256:createHash('sha256').update(handoff).digest('hex'),alreadyApplied:existing.some(x=>x.content===handoff),applied:false};
  if(!apply||info.alreadyApplied)return info;
  if(!backupPath)throw Error('Backup required');
  if(resolve(backupPath).startsWith(resolve(process.cwd())+'/'))throw Error('Backup must be outside the checkout to protect project credentials and prompts');
  const prior=db.prepare('SELECT * FROM memories WHERE villa_id=? AND kind=?').all(villa.id,'CONSTRAINT');
  mkdirSync(dirname(resolve(backupPath)),{recursive:true});
  writeFileSync(resolve(backupPath),JSON.stringify({proposal,villa,root,prior},null,2),{flag:'wx',mode:0o600});
  db.exec('BEGIN IMMEDIATE');
  try {
    const current=findNexusSphere(db);
    if(current.villa.id!==villa.id||current.proposal.masterprompt!==proposal.masterprompt||current.villa.idea!==villa.idea||current.root.id!==root.id||current.root.system_prompt!==root.system_prompt)throw Error('Villa or root agent changed concurrently');
    db.prepare('DELETE FROM memories WHERE villa_id=? AND kind=? AND title=?').run(villa.id,'CONSTRAINT',title);
    db.prepare('INSERT INTO memories(villa_id,agent_id,scope,kind,title,content,importance,created_at) VALUES (?,?,?,?,?,?,?,?)').run(villa.id,root.id,'villa','CONSTRAINT',title,handoff,10,Date.now());
    db.exec('COMMIT');
    return {...info,applied:true,backupPath};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  if(!process.env.VF_DB)throw Error('VF_DB must point to actual Hub database');
  const apply=process.argv.includes('--apply');
  const master=readFileSync(resolve('villa-prompts/nexussphere-production-completion.md'),'utf8');
  const db=new DatabaseSync(resolve(process.env.VF_DB),{readOnly:!apply});
  try{console.log(JSON.stringify(updateRunningVilla(db,master,{apply,backupPath:apply?resolve(process.env.NEXUS_BACKUP_DIR || '/tmp/nexussphere-backups','running-villa-'+Date.now()+'.json'):null}),null,2));}
  finally{db.close();}
}
