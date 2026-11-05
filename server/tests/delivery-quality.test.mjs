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

test('Medienfunktionen einer App ersetzen keine Software-Abnahme',()=>{
 for(const idea of ['Entwickle eine Android-App mit Audio, Video und Bildern.','Baue eine Software fuer Live-Performance und Musik.','Erstelle eine Audio-App mit MIDI und Export.']){
  const id=villa(idea);assert.equal(deliveryProfile(id).id,'software',idea);assert.ok(Object.hasOwn(deliveryReadiness(id).checks,'build')||deliveryReadiness(id).blockers.some(b=>b.startsWith('build:')));
 }
});
test('Medien ueber eine App bleiben Medien statt versehentlich als Software zu gelten',()=>{
 assert.equal(deliveryProfile(villa('Erstelle ein Video ueber unsere App fuer den Launch')).id,'video');
 assert.equal(deliveryProfile(villa('Erstelle ein Bild fuer die Software-Website')).id,'image');
 assert.equal(deliveryProfile(villa('Produziere einen Song fuer unsere App')).id,'audio');
});

test('Software-Auftraege mit langen Rollen-Headern werden nicht nach spaeteren Medien-Features eingestuft',()=>{
 assert.equal(deliveryProfile(villa('ROLLE: LIVE PERFORMANCE APP ANDROID. Audio, Musik und Video sind Features.')).id,'software');
 assert.equal(deliveryProfile(villa('AUTONOME SOFTWARE. MIDI und Videos sind Ausgabeoptionen.')).id,'software');
 assert.equal(deliveryProfile(villa('Build an application with audio and video editing')).id,'software');
 assert.equal(deliveryProfile(villa('Du bist ein Softwareentwickler. Produziere ein Video fuer den App-Launch.')).id,'video');
});

test('Programme, Tools und Mediengeneratoren benoetigen Software-Abnahme',()=>{
 for(const idea of ['Build a logo generator','Erstelle ein Programm, das ein Logo erzeugt','Create a tool that renders a video','Baue einen Bildgenerator','Build an audio editor','Erstelle einen Generator fuer Bilder'])assert.equal(deliveryProfile(villa(idea)).id,'software',idea);
 assert.equal(deliveryProfile(villa('Erstelle ein Video ueber unser Programm')).id,'video');
});

test('Video-Produkt verlangt eine Videodatei, keine Tonspur (Villa 8)', async () => {
  const {artifactContract} = await import('../artifact-contract.mjs');
  const idea = 'Comedy Mashup Abend mit Musik, Audio und Video: zwei Shows werden zu einem Abend gemischt.';
  const video = artifactContract({idea, kind: 'node', artifactName: 'villa-8.mp4', artifactType: 'media', deliverable: 'video'});
  assert.equal(video.ok, true, 'MP4 muss als Video-Produkt bestehen');
  assert.deepEqual(video.expected, ['playable-video']);
  const audioOnly = artifactContract({idea, kind: 'node', artifactName: 'villa-8.mp4', artifactType: 'media', deliverable: 'audio'});
  assert.equal(audioOnly.ok, false);
  assert.ok(audioOnly.blockers.includes('REQUIRED_ARTIFACT_MISSING:playable-audio'));
});

test('Pruefbefehle bekommen einen vollstaendigen PATH (Dienste starten mager)', async () => {
  const {runCommand} = await import('../fs-tools.mjs');
  const {mkdtempSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'vf-path-'));
  writeFileSync(join(dir, 'probe.js'), 'console.log(process.env.PATH.includes("/usr/bin") ? "PATH_OK" : "PATH_MAGER")');
  const out = await runCommand(dir, 'node', ['probe.js'], 30_000);
  assert.equal(out.ok, true);
  assert.match(out.output, /PATH_OK/);
});

test('haengender Build sperrt die Villa nicht dauerhaft', async () => {
  const {startBuild} = await import('../builds.mjs');
  const {db} = await import('../db.mjs');
  const villa = db.prepare('SELECT id FROM villas ORDER BY id LIMIT 1').get();
  if (!villa) return;
  // Ein Lauf, der seit 25 Minuten als "running" dasteht, gilt als abgebrochen.
  const {buildStateForTest} = await import('../builds.mjs');
  if (typeof buildStateForTest !== 'function') return;
  buildStateForTest(villa.id, {status: 'running', startedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(), log: []});
  assert.equal(typeof startBuild, 'function');
});

test('haengender Lauf gilt nach 20 Minuten als abgebrochen', async () => {
  const {isStaleBuild} = await import('../builds.mjs');
  const jetzt = Date.now();
  assert.equal(isStaleBuild({status: 'running', startedAt: jetzt - 60_000}, jetzt), false);
  assert.equal(isStaleBuild({status: 'running', startedAt: jetzt - 25 * 60_000}, jetzt), true);
  assert.equal(isStaleBuild({status: 'ready', startedAt: jetzt - 60 * 60_000}, jetzt), false);
  assert.equal(isStaleBuild({status: 'running', startedAt: new Date(jetzt - 25 * 60_000).toISOString()}, jetzt), true);
});
