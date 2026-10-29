import './_env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { createMasterControl, validateAction } from '../master-control.mjs';
import { duplicateGroups, archiveDuplicates, restoreVilla } from '../duplicates.mjs';
import { suggestions } from '../suggestions.mjs';
import { skillInstructions, publicAddress, validEndpoint, getSetting } from '../control-store.mjs';
import { packState, setPackEnabled, canUseTool } from '../packs.mjs';

beforeEach(() => { for (const t of ['control_messages','control_turns','control_archives','control_settings','control_skills','control_connectors','control_tools','control_dismissals','packs','tasks','agents','memories','reports','villas']) db.prepare(`DELETE FROM ${t}`).run(); });
function villa(name='Studio', idea='Musik produzieren', source='') {
  return Number(db.prepare('INSERT INTO villas(name,idea,status,created_at,updated_at,source_path) VALUES (?,?,?,?,?,?)').run(name,idea,'PAUSED',1,1,source).lastInsertRowid);
}
function task(id,title,status='PENDING') { db.prepare('INSERT INTO tasks(villa_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,title,status,1,1); }
function control(actions=[], create, cancelScheduledVilla=()=>false) {
  let calls=0;
  const service = createMasterControl({
    chat: async () => ({content:JSON.stringify({answer:'Plan',actions})}),
    createVilla: create || (async args => { calls++; const id=villa(args.name,args.idea); return {villaId:id,rootId:1}; }),
    isRunning: () => false, stopVilla: () => false, cancelScheduledVilla, startVilla:id=>({started:id}),packState,setPackEnabled,
    toolSpecs:()=>[{name:'web_fetch',enabled:canUseTool('web_fetch').allowed}],emit:()=>{}
  });
  return {service,calls:()=>calls};
}
test('Dubletten: genaue normalisierte Identität, reichster Arbeitsstand bleibt, nichts wird gelöscht', () => {
  const a=villa('Studio','Musik produzieren'), b=villa('  STUDIO  ','Musik   produzieren');
  villa('Studio','Anderes Ziel'); villa('Studio','Musik produzieren','/anderer-pfad');
  task(a,'Plan'); task(b,'Code','DONE');
  const groups=duplicateGroups(); assert.equal(groups.length,1); assert.equal(groups[0].keep,b);
  const out=archiveDuplicates(); assert.deepEqual(out.archived,[{id:a,kept:b}]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM villas').get().c,4);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c,2);
  assert.equal(db.prepare('SELECT status,autonomy FROM villas WHERE id=?').get(a).status,'ARCHIVED');
  assert.equal(duplicateGroups().length,0);
  restoreVilla(a); assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(a).status,'PAUSED');
});
test('Laufende Dubletten werden niemals während eines Jobs archiviert', () => {
  const a=villa(),b=villa(); const running=()=>true;
  const out=archiveDuplicates(running); assert.equal(out.archived.length,0); assert.equal(out.skipped.length,1);
  assert.notEqual(db.prepare('SELECT status FROM villas WHERE id=?').get(b).status,'ARCHIVED');
  assert.equal(duplicateGroups(running)[0].keep,a);
});
test('Gleichzeitiges Anlegen derselben Villa ist idempotent und erzeugt keinen zweiten Datensatz', async () => {
  let calls=0;
  const {service}=control([],async args=>{calls++; await new Promise(r=>setTimeout(r,15));return {villaId:villa(args.name,args.idea)};});
  const args={name:'Neu',idea:'Neue Idee'};
  const [a,b]=await Promise.all([service.createUniqueVilla(args),service.createUniqueVilla(args)]);
  assert.equal(a.villaId,b.villaId); assert.equal(calls,1);
  assert.equal((await service.createUniqueVilla(args)).existing,true);
});
test('Master-Turn wird bei Retry nicht erneut ausgeführt und behält einen Projektauftrag', async () => {
  const {service,calls}=control([{type:'create_villa',args:{name:'Studio',idea:'Audio',prompt:'Echte Latenz prüfen',agentCount:3}}]);
  const input={message:'Baue mein Audio-Projekt',requestId:'turn-idempotent-1'};
  const first=await service.turn(input), second=await service.turn(input);
  assert.deepEqual(first,second);assert.equal(calls(),1);assert.equal(first.ok,true);
  assert.match(db.prepare("SELECT content FROM memories WHERE kind='CONSTRAINT'").get().content,/Latenz/);
  await assert.rejects(service.turn({...input,message:'Anderer Inhalt'}),/andere/);
});
test('Master-Planung priorisiert kostenlose Cloud-Qualitätsrouten und begrenzt die Antwortzeit', async () => {
  let options;
  const service=createMasterControl({
    chat:async(_messages,opts)=>{options=opts;return {content:JSON.stringify({answer:'Status ist bereit.',actions:[]})};},
    createVilla:async()=>{throw new Error('unexpected');},isRunning:()=>false,stopVilla:()=>false,startVilla:()=>{},
    packState,setPackEnabled,toolSpecs:()=>[],emit:()=>{}
  });
  const out=await service.turn({message:'Wie kann ich das Projekt verbessern?',requestId:'master-quality-route-1'});
  assert.equal(out.ok,true);
  assert.equal(options.role,'ARCHITECT');
  assert.equal(options.priority,'interactive');
  assert.equal(options.strategy,'FALLBACK');
  assert.equal(options.totalTimeoutMs,60000);
  assert.equal(options.maxTokens,1200);
});
test('Eigene Skills und einzelne Werkzeugschalter sind echte Laufzeitkonfiguration', async () => {
  const {service}=control([{type:'upsert_skill',args:{id:'quality',title:'Qualität',instructions:'Prüfe Fehlerfälle'}},{type:'set_tool',args:{name:'web_fetch',enabled:false}}]);
  const out=await service.turn({message:'Speichere Arbeitsregeln',requestId:'turn-skills-1234'});
  assert.equal(out.ok,true);assert.match(skillInstructions(),/Fehlerfälle/);assert.equal(canUseTool('web_fetch').allowed,false);
});
test('Unbekannte Aktionen oder ungültige Parameter verändern nichts', async () => {
  const {service}=control([{type:'upsert_skill',args:{id:'valid',title:'Test',instructions:'Prüfen'}},{type:'shell',args:{command:'rm -rf'}}]);
  const out=await service.turn({message:'Test',requestId:'turn-invalid-123'});assert.equal(out.ok,false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM control_skills').get().c,0);
  assert.throws(()=>validateAction({type:'set_setting',args:{key:'villaSlots',value:100}}),/ungültig/);
  assert.throws(()=>validateAction({type:'set_setting',args:{key:'villaSlots',value:0}}),/ungültig/);
  assert.equal(getSetting('villaSlots'),6);
});
test('Connectoren sperren private Adressen und unbeauftragte Schlüsselzuordnung', () => {
  for (const ip of ['127.0.0.1','10.2.3.4','192.168.1.1','169.254.169.254','::1','fe80::1','::ffff:127.0.0.1']) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);
  for (const url of ['http://example.com','https://127.0.0.1','https://local.internal','https://user:pass@example.com','https://example.com?key=secret']) assert.throws(()=>validEndpoint(url));
  assert.throws(()=>validateAction({type:'upsert_connector',args:{id:'external',title:'API',endpoint:'https://example.com/data',secretEnv:'GITHUB_TOKEN'}},'Verbinde eine API'),/ausdrücklich/);
});
test('Vorschläge priorisieren Fehler, wiederholen keine Aufgaben und respektieren ausgeblendete Karten', () => {
  const id=villa();task(id,'Fehler beheben','FAILED');task(id,'Audio bauen');task(id,'Audio bauen');
  const out=suggestions(id);assert.equal(out[0].kind,'repair');assert.equal(out.filter(r=>r.title==='Audio bauen').length,1);
  const {service}=control();service.dismiss(out[0].id);assert.ok(!suggestions(id).some(r=>r.id===out[0].id));
});
test('Ohne KI-Route bleiben Status und Dublettenbereinigung nutzbar', async () => {
  villa();villa();const {service}=control();
  const out=await service.turn({message:'Archiviere doppelte Villen',requestId:'offline-duplicates'});
  assert.equal(out.ok,true);assert.equal(out.steps[0].result.archived.length,1);
  assert.match((await service.turn({message:'Status',requestId:'offline-status-12'})).answer,/sichtbare Villen/);
});
test('App-weite Verwaltung lehnt Nicht-Administratoren vor jedem Zugriff ab', async () => {
 const {service}=control();let response;
 await service.handle({method:'POST'},{},new URL('http://localhost/api/master/chat'),()=>{throw new Error('body must not be read');},(_,status,body)=>{response={status,body};},false);
 assert.equal(response.status,403);assert.equal(db.prepare('SELECT COUNT(*) c FROM control_turns').get().c,0);
});
test('Ein unaufgeforderter Start verhindert den gesamten Plan vor der ersten Änderung',async()=>{
 const id=villa();
 const {service}=control([{type:'set_setting',args:{key:'suggestionCount',value:8}},{type:'start_villa',args:{villaId:id}}]);
 const out=await service.turn({message:'Ändere das Vorschlagslimit',requestId:'no-implicit-start-123'});
 assert.equal(out.ok,false);assert.equal(out.steps.length,0);assert.equal(getSetting('suggestionCount'),4);
});
test('Pausieren entfernt nur die vorgemerkte Villa und deaktiviert ihre Autonomie',async()=>{
 const id=villa();const cancelled=[];
 const {service}=control([{type:'pause_villa',args:{villaId:id}}],undefined,selected=>{cancelled.push(selected);return true;});
 const out=await service.turn({message:'Pausiere Studio',requestId:'pause-villa-queue-1'});
 assert.equal(out.ok,true);assert.deepEqual(cancelled,[id]);
 const paused=db.prepare('SELECT status,autonomy FROM villas WHERE id=?').get(id);
 assert.equal(paused.status,'PAUSED');assert.equal(paused.autonomy,0);
});
test('Expliziter Start reaktiviert eine zuvor pausierte Villa',async()=>{
 const id=villa();db.prepare('UPDATE villas SET autonomy=0,status=\'PAUSED\' WHERE id=?').run(id);
 const {service}=control([{type:'start_villa',args:{villaId:id}}]);
 const out=await service.turn({message:'Starte Studio',requestId:'start-villa-resume-1'});
 assert.equal(out.ok,true);assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(id).autonomy,1);
});

test('Master planning context stays valid JSON, bounds large catalogs and omits skill bodies',async()=>{
 const {masterPlanningContext}=await import('../master-control.mjs');
 const rows=Array.from({length:200},(_,i)=>({id:i,name:'Villa '+i+'x'.repeat(100),status:'PAUSED',autonomy:0,title:'Title '+i,instructions:'sensitive skill body'.repeat(500),enabled:true,model:'model'}));
 const input={villas:rows,tools:rows.map(x=>({...x,name:'tool'+x.id})),routes:rows,skills:rows,connectors:rows,archived:rows,packs:{features:rows}};
 const out=masterPlanningContext(input,'Bitte LLM Routen analysieren');const json=JSON.stringify(out);
 assert.ok(json.length<=8000);assert.equal(out.totals.villas,200);assert.ok(!json.includes('sensitive skill body'));assert.deepEqual(JSON.parse(json),out);
 assert.deepEqual(masterPlanningContext(input,'Erkläre die Bedienung').routes,[]);
});
