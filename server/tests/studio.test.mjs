import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'studio-'));process.env.VF_DB=join(root,'db');process.env.VF_WORKSPACE=join(root,'workspace');
const {db,now}=await import('../db.mjs');
const {ownProjectDir}=await import('../project-verification.mjs');
const {studioStatus,validateDesigns,proposeDesigns,selectDesign,createPreviewSession,serveStudioPreview}=await import('../studio.mjs');
const {previewFile}=await import('../builds.mjs');
const {guessRole}=await import('../agents.mjs');
const id=Number(db.prepare('INSERT INTO villas(name,idea,status,created_at,updated_at) VALUES (?,?,?, ?,?)').run('Audio Bühne','Live-Musik mit großen Pads','PAUSED',now(),now()).lastInsertRowid);
const variants=['Fokus','Bühne'].map(name=>({name,reason:'Große Pads für die konkrete Live-Musik-Idee',palette:{background:'#101010',surface:'#202020',text:'#ffffff',accent:'#22cccc'},layout:['Master-Transport','Vier große Sample-Pads'],flow:['Sample wählen','Pad spielen'],acceptance:['Pad-Ziel mindestens 48 Pixel','Fehlerzustand bei fehlendem Audio']}));
test('Nächste Schritte kommen aus echten Blockern und fehlgeschlagenen Aufgaben',()=>{
 db.prepare("INSERT INTO tasks(villa_id,title,result,status,created_at,updated_at) VALUES (?,'Audio-Latenz korrigieren','Grenzwert überschritten','FAILED',?,?)").run(id,now(),now());
 const s=studioStatus(id);assert.equal(s.nextSteps[0].title,'Audio-Latenz korrigieren');assert.match(s.nextSteps[0].prompt,/Aufgabe #/);assert.ok(s.maturity.blockers.length);
});
test('Designs brauchen zwei konkrete Richtungen und lesbaren Kontrast',()=>{assert.equal(validateDesigns(variants).length,2);assert.throws(()=>validateDesigns([variants[0]]));assert.throws(()=>validateDesigns(variants.map(v=>({...v,palette:{...v.palette,text:'#222222'}}))),/kontrast/i);});
test('Design-Modell erhält Idee und aktuelle Blocker; Auswahl wirkt als Agenten-Vorgabe',async()=>{
 let prompt;const out=await proposeDesigns(id,{chatFn:async msgs=>{prompt=msgs[1].content;return {content:JSON.stringify({variants})};}});
 assert.match(prompt,/Live-Musik/);assert.match(prompt,/blockers/);assert.equal(out.variants.length,2);
 const selected=selectDesign(id,out.id,1);assert.equal(selected.saved,true);assert.match(db.prepare("SELECT content FROM memories WHERE title='Studio: gewählte Designrichtung'").get().content,/Bühne/);
 assert.equal(studioStatus(id).design.selected,1);
});
test('Kein Modell bedeutet keine erfundenen Designvorschläge',async()=>{await assert.rejects(proposeDesigns(id,{chatFn:async()=>({offline:true})}),e=>e.code==='LLM_UNAVAILABLE');});
test('Preview gibt nur gebaute Dateien frei; Traversal und Symlink-Flucht sind gesperrt',()=>{
 const p=ownProjectDir(id);mkdirSync(join(p,'dist','assets'),{recursive:true});writeFileSync(join(p,'dist','index.html'),'<html><head></head><body><script src="/assets/app.js"></script></body></html>');writeFileSync(join(p,'dist','assets','app.js'),'console.log("preview")');writeFileSync(join(root,'secret.txt'),'secret');symlinkSync(join(root,'secret.txt'),join(p,'dist','escape.txt'));
 assert.equal(previewFile(id,'dist/../package.json'),null);assert.equal(previewFile(id,'dist/escape.txt'),null);assert.equal(previewFile(id,'dist/%2e%2e/package.json'),null);
 const session=createPreviewSession(id);assert.equal(session.available,true);let status,headers,body;
 const res={writeHead(s,h){status=s;headers=h;},end(b){body=String(b||'');}};
 serveStudioPreview({method:'GET',headers:{host:'localhost'},socket:{}},res,new URL('http://localhost'+session.path));assert.equal(status,200);assert.match(body,/studio-preview\//);assert.match(headers['content-security-policy'],/form-action 'none'/);
 serveStudioPreview({method:'GET',headers:{host:'localhost'},socket:{}},res,new URL('http://localhost/studio-preview/not-valid/'));assert.equal(status,404);
});
test('Explizite Rollen verhindern, dass Integrations- und Codearbeit als Standard-Planung läuft',()=>{assert.equal(guessRole({title:'Umsatz-Plan umsetzen',description:'Rolle: CODER.'}),'CODER');assert.equal(guessRole({title:'Lauffähiges Produkt prüfen',description:'Keine weiteren Planungsberichte. Rolle: INTEGRATOR.'}),'INTEGRATOR');});
