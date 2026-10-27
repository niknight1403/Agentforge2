import './_env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {db,now} from '../db.mjs';
import {PROJECT_WORKSPACE} from '../project-verification.mjs';
import {deliveryProfile,deliveryReadiness} from '../delivery-quality.mjs';
import {maturity,developCycle} from '../product.mjs';
function villa(idea){return Number(db.prepare("INSERT INTO villas(name,idea,status,created_at,updated_at) VALUES (?,?,'PAUSED',?,?)").run('Quality test',idea,now(),now()).lastInsertRowid);}
function deliverable(id,name){const dir=join(PROJECT_WORKSPACE,`villa-${id}`,'deliverables');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,name),Buffer.alloc(256,1));}
function review(id,result='Kontrast und Lesbarkeit geprüft; Korrekturen dokumentiert.'){
 const reviewer=Number(db.prepare('INSERT INTO agents(villa_id,name,role,created_at,last_active_at) VALUES (?,?,?,?,?)').run(id,'Quality reviewer','REVIEWER',now(),now()).lastInsertRowid);
 db.prepare('INSERT INTO tasks(villa_id,agent_id,title,status,result,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(id,reviewer,'Unabhängiges Qualitätsreview','DONE',result,now(),now());
}
test('Bild- und Medien-Villen werden nach Artefakttyp erkannt',()=>{
 assert.equal(deliveryProfile(villa('Erstelle ein hochwertiges Kampagnenbild')).id,'image');
 assert.equal(deliveryProfile(villa('Produziere ein kurzes Video')).id,'video');
 assert.equal(deliveryProfile(villa('Erstelle einen Pitch für Investoren')).id,'pitch');
 assert.equal(deliveryProfile(villa('Baue einen Hardware-Prototyp')).id,'invention');
});
test('Kreativprojekt bleibt gesperrt, bis finales Artefakt und Review durch unabhängigen Agenten vorliegen',()=>{
 const id=villa('Erstelle ein Kampagnenbild');deliverable(id,'hero.png');
 assert.equal(deliveryReadiness(id).verified,false);
 assert.ok(deliveryReadiness(id).blockers.some(b=>b.includes('Review')));
 review(id);assert.equal(deliveryReadiness(id).verified,true);
});
test('Erledigtes Review ohne echte Ergebnisdatei gilt nicht als Abnahme',()=>{
 const id=villa('Produziere ein kurzes Video');review(id);
 const ready=deliveryReadiness(id);assert.equal(ready.verified,false);assert.ok(ready.blockers[0].includes('Artefakt'));
});
test('Review durch normalen Worker zählt nicht als unabhängige Abnahme',()=>{
 const id=villa('Erstelle eine Pitch-Präsentation');deliverable(id,'pitch.pdf');
 const worker=Number(db.prepare('INSERT INTO agents(villa_id,name,role,created_at,last_active_at) VALUES (?,?,?,?,?)').run(id,'Worker','WORKER',now(),now()).lastInsertRowid);
 db.prepare('INSERT INTO tasks(villa_id,agent_id,title,status,result,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(id,worker,'Unabhängiges Qualitätsreview','DONE','Fakten und Lesbarkeit geprüft; Korrekturen dokumentiert.',now(),now());
 assert.equal(deliveryReadiness(id).verified,false);
});

test('Creative-Villen erhalten passende Meilensteine statt Software-Verifikation',()=>{
 const id=villa('Erstelle ein Kampagnenbild');const m=maturity(id);
 assert.equal(m.domain,'image');assert.equal(m.phases.length,5);
 assert.ok(m.phases.some(p=>p.title==='Finales Bild produzieren'));
 developCycle(id);
 assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id=? AND title LIKE '[VERIFICATION]%'").get(id).c,0);
 assert.ok(db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id=? AND title LIKE '[BRIEF]%'").get(id).c>0);
});
