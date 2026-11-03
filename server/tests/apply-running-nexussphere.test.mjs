import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findNexusSphere,updateRunningVilla} from '../scripts/apply-running-nexussphere.mjs';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE proposals(id INTEGER PRIMARY KEY,title TEXT,proposed_name TEXT,masterprompt TEXT,status TEXT,villa_id INTEGER);
 CREATE TABLE villas(id INTEGER PRIMARY KEY,name TEXT,idea TEXT,status TEXT);
 CREATE TABLE agents(id INTEGER PRIMARY KEY,villa_id INTEGER,is_root INTEGER,system_prompt TEXT);
 CREATE TABLE memories(id INTEGER PRIMARY KEY,villa_id INTEGER,agent_id INTEGER,scope TEXT,kind TEXT,title TEXT,content TEXT,importance INTEGER,created_at INTEGER);
 INSERT INTO proposals VALUES(1,'Project','NexusSphere','ORIGINAL SPEC','approved',14);
 INSERT INTO villas VALUES(14,'NexusSphere','Original idea','RUNNING');
 INSERT INTO agents VALUES(9,14,1,'Original root system prompt');`);
 return db;
}
test('running villa handoff is backed up, safe and idempotent',()=>{
 const db=fixture(),backup=join(mkdtempSync(join(tmpdir(),'nexus-')),'backup.json');
 assert.equal(updateRunningVilla(db,'M'.repeat(700)).applied,false);
 assert.equal(updateRunningVilla(db,'M'.repeat(700),{apply:true,backupPath:backup}).applied,true);
 assert.match(readFileSync(backup,'utf8'),/ORIGINAL SPEC/);
 assert.match(db.prepare('SELECT content FROM memories').get().content,/ORIGINAL SPEC/);
 assert.equal(db.prepare('SELECT idea FROM villas').get().idea,'Original idea');
 assert.equal(db.prepare('SELECT system_prompt FROM agents').get().system_prompt,'Original root system prompt');
 assert.equal(updateRunningVilla(db,'M'.repeat(700),{apply:true}).alreadyApplied,true);
 assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,1);
});
test('wrong villa linkage is rejected',()=>{
 const db=fixture();db.exec("UPDATE villas SET name='Another' WHERE id=14");
 assert.throws(()=>findNexusSphere(db),/mismatch/);
});
test('ambiguous or unapproved proposals are rejected',()=>{
 const db=fixture();
 db.exec("INSERT INTO proposals VALUES(2,'NexusSphere','NexusSphere','OTHER','pending',NULL)");
 assert.throws(()=>findNexusSphere(db),/exactly one/);
 db.exec("DELETE FROM proposals WHERE id=2; UPDATE proposals SET status='pending' WHERE id=1");
 assert.throws(()=>findNexusSphere(db),/approved villa/);
});

test('refuses backups inside the Git checkout',()=>{
 const db=fixture();
 assert.throws(()=>updateRunningVilla(db,'M'.repeat(700),{apply:true,backupPath:join(process.cwd(),'dangerous-backup.json')}),/outside the checkout/);
 assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,0);
});
test('does not mutate an unlinked villa',()=>{
 const db=fixture();
 db.exec("UPDATE proposals SET villa_id=99 WHERE id=1");
 assert.throws(()=>updateRunningVilla(db,'M'.repeat(700),{apply:true,backupPath:join(tmpdir(),'nexus-unused.json')}),/missing or name mismatch/);
 assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,0);
});
