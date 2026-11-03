import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'vf-build-source-'));
process.env.VF_DB=join(temp,'db.sqlite');
process.env.VF_WORKSPACE=join(temp,'workspace');
const {db,now}=await import('../db.mjs');
const {sourceRoot,runTool}=await import('../agents.mjs');
const {ownProjectDir}=await import('../project-verification.mjs');
function villa(mode='BUILD',path=''){
 return Number(db.prepare('INSERT INTO villas(name,idea,status,source_path,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
 .run('Test Villa','Erstelle eine mobile Web-App mit echter Datei.', 'RUNNING',path,mode,now(),now()).lastInsertRowid);
}
test('Legacy idea-only BUILD villa gets an isolated writable project root',()=>{
 const id=villa();
 const root=sourceRoot(id);
 assert.equal(root,ownProjectDir(id));
 assert.ok(existsSync(root));
 assert.equal(db.prepare('SELECT source_path FROM villas WHERE id=?').get(id).source_path,root);
 assert.equal(sourceRoot(id),root);
});
test('Project write now succeeds for a BUILD Villa without imported repository',async()=>{
 const id=villa();
 const result=await runTool({villaId:id,agentId:0},'project_write',{path:'src/app.mjs',content:'export const value=42;'});
 assert.ok(existsSync(join(ownProjectDir(id),'src','app.mjs')),String(result));
 assert.equal(readFileSync(join(ownProjectDir(id),'src','app.mjs'),'utf8'),'export const value=42;');
});
test('ANALYZE villa must not be assigned an unrelated project root',()=>{
 const id=villa('ANALYZE');
 assert.equal(sourceRoot(id),null);
 assert.equal(db.prepare('SELECT source_path FROM villas WHERE id=?').get(id).source_path,'');
 assert.equal(existsSync(ownProjectDir(id)),false);
});
test('Existing linked source path is preserved exactly',()=>{
 const external=resolve(temp,'existing');
 const id=villa('BUILD',external);
 assert.equal(sourceRoot(id),external);
 assert.equal(db.prepare('SELECT source_path FROM villas WHERE id=?').get(id).source_path,external);
});
