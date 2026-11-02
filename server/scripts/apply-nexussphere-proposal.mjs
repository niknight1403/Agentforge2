#!/usr/bin/env node
// Apply the NexusSphere completion prompt to the exact pending project proposal.
// Dry-run by default. Run from the repository root with VF_DB set.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const val = (key) => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
const requestedId = val('--id');
const promptFile = val('--prompt') || 'villa-prompts/nexussphere-production-completion.md';
if (!process.env.VF_DB) throw new Error('VF_DB must identify an existing Hub database');
const master = readFileSync(resolve(promptFile), 'utf8').trim();
if (master.length < 500) throw new Error('Optimized prompt missing or unexpectedly short');
const db = new DatabaseSync(resolve(process.env.VF_DB), {readOnly: !apply});
try {
  const matches = db.prepare("SELECT id,title,proposed_name,masterprompt,status,villa_id FROM proposals WHERE lower(trim(proposed_name))='nexussphere' OR lower(trim(title))='nexussphere' ORDER BY id").all();
  if (matches.length !== 1) throw new Error('Expected exactly one NexusSphere proposal, found ' + matches.length);
  const p = matches[0];
  if (requestedId !== null && Number(requestedId) !== p.id) throw new Error('Proposal ID mismatch');
  if (p.status !== 'pending' || p.villa_id != null) throw new Error('Only pending, unassigned proposals can be updated');
  const original = (p.masterprompt || '').trim();
  if (!original) throw new Error('Original project specification missing');
  const updated = master + '\n\n---\n\n# Verbindlicher ursprünglicher NexusSphere-Projektauftrag\n\n' + original;
  if (updated.length > 120000) throw new Error('Prompt exceeds maximum size');
  const info = {id:p.id,name:p.proposed_name,status:p.status,oldLength:original.length,newLength:updated.length,sha256:createHash('sha256').update(updated).digest('hex'),applied:false};
  if (!apply) {
    console.log(JSON.stringify(info,null,2));
  } else {
    const backupDir = resolve(process.env.NEXUS_BACKUP_DIR || 'backups/nexussphere');
    mkdirSync(backupDir,{recursive:true});
    const backup = resolve(backupDir, 'proposal-'+p.id+'-'+Date.now()+'.json');
    writeFileSync(backup,JSON.stringify(p,null,2),{flag:'wx',mode:0o600});
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare("UPDATE proposals SET masterprompt=? WHERE id=? AND status='pending' AND villa_id IS NULL AND masterprompt=?").run(updated,p.id,p.masterprompt);
      if (result.changes !== 1) throw new Error('Concurrent change detected; aborting');
      db.exec('COMMIT');
      console.log(JSON.stringify({...info,applied:true,backup},null,2));
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
} finally { db.close(); }
