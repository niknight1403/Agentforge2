import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, extname } from 'node:path';
import { db } from './db.mjs';
import { PROJECT_WORKSPACE, projectDirectory, projectReadiness } from './project-verification.mjs';

const PROFILES = {
  software: { label:'Software', extensions:['.apk','.aab','.zip'], phases:[
    ['DISCOVERY','Zielgruppe & Erfolgsmaß','Belege Zielgruppe, Kernproblem und messbares Erfolgskriterium.'],
    ['DESIGN','UX-Fluss & Architektur','Definiere Nutzerfluss, Akzeptanzkriterien und wartbare Architektur.'],
    ['BUILD','Produktkern implementieren','Liefere lauffähige Kernfunktionen mit Startanleitung und Fehlerbehandlung.'],
    ['QUALITY','Unabhängiges Qualitätsreview','Prüfe Code, Sicherheit, Barrierefreiheit und Randfälle; dokumentiere Befunde und Fixes.'],
    ['RELEASE','Release & Betrieb','Erstelle Release-Artefakt, Installationsanleitung, Monitoring und Rollback-Plan.']
  ]},
  image: { label:'Bild / Grafik', extensions:['.png','.jpg','.jpeg','.webp','.svg','.tif','.tiff'], phases:[
    ['BRIEF','Kreativbrief & Einsatz','Lege Zielgruppe, Botschaft, Einsatzort, Format, Rechte und Erfolgskriterien fest.'],
    ['DIRECTION','Visuelle Richtungen','Entwickle mindestens zwei unterscheidbare Richtungen mit Begründung zu Komposition, Typografie und Farbkontrast.'],
    ['PRODUCTION','Finales Bild produzieren','Erzeuge und exportiere das finale Bild in benötigter Auflösung und in einem geeigneten Zielformat.'],
    ['REVIEW','Bildqualität unabhängig prüfen','Prüfe Lesbarkeit, Kontrast, Crop, Artefakte, Markenpassung und Rechte; protokolliere Korrekturen.'],
    ['DELIVERY','Varianten & Übergabe','Liefere finale Datei plus passende Größen/Varianten und eine kurze Nutzungsnotiz.']
  ]},
  video: { label:'Video', extensions:['.mp4','.webm','.mov','.m4v'], phases:[
    ['BRIEF','Ziel & Format definieren','Lege Publikum, Plattform, Laufzeit, Hook, Botschaft, Rechte und messbares Ziel fest.'],
    ['SCRIPT','Skript & Storyboard','Erstelle Hook, vollständiges Skript, Szenenfolge, Shotlist und Timing.'],
    ['PRODUCTION','Video rendern','Erzeuge ein abspielbares Video im vereinbarten Seitenverhältnis und Zielformat.'],
    ['REVIEW','Video unabhängig prüfen','Prüfe Bild/Ton-Sync, Verständlichkeit, Untertitel, Schnitt, Lautheit, Rechte und technische Wiedergabe.'],
    ['DELIVERY','Export & Übergabe','Liefere finale Datei, Untertitel, Vorschaubild und Exportparameter für die Zielplattform.']
  ]},
  audio: { label:'Audio / Musik', extensions:['.wav','.mp3','.flac','.ogg','.m4a','.aac'], phases:[
    ['BRIEF','Audio-Brief definieren','Lege Nutzung, Zielgruppe, Stimmung, Dauer, Format, Lautheit und Rechte fest.'],
    ['ARRANGEMENT','Konzept & Arrangement','Erstelle Struktur, Tempo/Tonart oder Sprechablauf mit klarer Dramaturgie.'],
    ['PRODUCTION','Finales Audio rendern','Liefere einen abspielbaren Mix im vereinbarten Zielformat und in geeigneter Qualität.'],
    ['REVIEW','Audio unabhängig prüfen','Prüfe Verständlichkeit, Clipping, Rauschen, Pegel, Übergänge, Rechte und Gerätewiedergabe.'],
    ['DELIVERY','Master & Übergabe','Liefere Masterdatei, optional komprimierte Variante und dokumentierte Exportwerte.']
  ]},
  pitch: { label:'Pitch / Präsentation', extensions:['.pptx','.pdf','.key'], phases:[
    ['CASE','Problem & Belege','Belege Problem, Zielgruppe, Kundennutzen und zentrale Annahmen mit Quellen.'],
    ['STORY','Kernbotschaft & Story','Baue eine prägnante Dramaturgie mit nachvollziehbarer Argumentation und klarem Ask.'],
    ['DECK','Präsentation erstellen','Erzeuge ein vollständiges Deck mit konsistentem Design, lesbaren Charts und Quellenhinweisen.'],
    ['REVIEW','Pitch kritisch testen','Prüfe Fakten, Markt-/Finanzlogik, Verständlichkeit, Einwände und Lesbarkeit; dokumentiere Korrekturen.'],
    ['DELIVERY','Pitch-Paket liefern','Liefere editierbares Deck plus PDF, Sprecherhinweise und nächste Validierungsschritte.']
  ]},
  invention: { label:'Erfindung / Prototyp', extensions:['.stl','.step','.stp','.obj','.gltf','.glb','.3mf','.ino','.zip','.pdf'], phases:[
    ['NEED','Bedarf & Anforderungen','Definiere Nutzerproblem, Einsatzbedingungen, Anforderungen und messbare Erfolgskriterien.'],
    ['FEASIBILITY','Machbarkeit & Risiken','Prüfe technische Machbarkeit, bekannte Lösungen, Sicherheitsrisiken und offene Annahmen.'],
    ['PROTOTYPE','Prototyp erstellen','Liefere einen prüfbaren Prototyp, CAD-/Schaltungsartefakt oder ausführbaren Demonstrator.'],
    ['REVIEW','Prototyp unabhängig prüfen','Prüfe Anforderungen, Belastbarkeit, Bedienbarkeit und Sicherheit; dokumentiere Tests und Mängel.'],
    ['VALIDATION','Validierungsplan & Übergabe','Liefere Stückliste/Material, Kostenannahmen und einen priorisierten Testplan für den nächsten Reifegrad.']
  ]}
};
const SOFTWARE_HINT = /\b(app|application|software|webseite|website|webapp|plattform|dashboard|api|saas|code|programm|tool|system|entwickel|implementier|generator)\b/i;
function classify(idea='') {
  const s=String(idea);
  // Determine the requested deliverable, not a later feature/marketing subject.
  // An audio app needs software gates; a video about an app needs a video export.
  const normalized=s.replace(/\b(?:audio|musik|video|bildbearbeitungs|dj)[- ]app\b/gi,'App').replace(/\b(?:logo|bild|bilder|image|video|audio|musik|music)[- ]?(?:generator|editor|bearbeitungsprogramm)\b/gi,'Software');
  const softwareTargets=['app','application','software','anwendung','webapp','webseite','website','program','programm','tool','generator','editor','plattform','dashboard','api','saas','code','system'];
  const action=/\b(?:develop\w*|build|create|entwickl\w*|erstelle?|baue?|programmier\w*|implementier\w*|produzier\w*|generier\w*)\s+([^.!?\n]{0,180})/i.exec(normalized);
  const target=action?.[1].match(/\b(app|application|software|anwendung|webapp|webseite|website|program|programm|tool|generator|editor|plattform|dashboard|api|saas|code|system|video|film|clip|audio|musik|song|bild|bilder|grafik|logo|pitch|präsentation|praesentation|hardware|prototyp)\b/i)?.[1].toLowerCase();
  if(target){
    if(softwareTargets.includes(target))return 'software';
    if(['video','film','clip'].includes(target))return 'video';
    if(['audio','musik','song'].includes(target))return 'audio';
    if(['bild','bilder','grafik','logo'].includes(target))return 'image';
    if(['pitch','präsentation','praesentation'].includes(target))return 'pitch';
    if(['hardware','prototyp'].includes(target))return 'invention';
  }
  const heading=normalized.slice(0,600).match(/\b(app|application|software|anwendung|webapp|webseite|website|program|programm|tool|generator|editor|plattform|dashboard|api|saas|code|system|video|film|audio|musik|song|bild|bilder|grafik|logo|pitch|hardware|prototyp)\b/i)?.[1].toLowerCase();
  if(softwareTargets.includes(heading))return 'software';
  if(SOFTWARE_HINT.test(s)&&/\b(apk|aab|android[- ]app|ios[- ]app|flutter|gradle|react[- ]native)\b/i.test(s))return 'software';
  if (/\b(video|film|clip|animation|werbespot|reel)\b/i.test(s)) return 'video';
  if (/\b(audio|musik|song|soundtrack|voiceover|podcast|jingle)\b/i.test(s)) return 'audio';
  if (/\b(pitch|präsentation|praesentation|pitchdeck|deck|investorenpräsentation|investorenpraesentation)\b/i.test(s)) return 'pitch';
  if (/\b(erfindung|invention|prototyp|cad|produktentwicklung|hardware)\b/i.test(s)) return 'invention';
  if (/\b(bild|bilder|bilderstellung|bildgenerierung|kampagnenbild|grafik|illustration|logo|poster|cover|thumbnail|visual|kunstwerk|artwork)\b/i.test(s) && !SOFTWARE_HINT.test(s)) return 'image';
  return 'software';
}
export function deliveryProfile(villaId) {
  const villa=db.prepare('SELECT idea,name FROM villas WHERE id=?').get(Number(villaId));
  const id=classify(villa?.idea || villa?.name || '');
  return { id, ...PROFILES[id] };
}
function outputs(villaId, profile) {
  const roots=[join(PROJECT_WORKSPACE,`villa-${villaId}`)];
  try { roots.push(projectDirectory(villaId)); } catch {}
  const found=[], ignored=new Set(['node_modules','.git','.gradle','.next','dist','build','out','coverage']);
  for(const root of new Set(roots)) {
    if(!existsSync(root))continue;
    let real;try{real=realpathSync(root);}catch{continue;}
    function walk(dir,depth=0) {
      if(depth>8||found.length>=500)return;
      let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
      for(const entry of entries) {
        if(ignored.has(entry.name)||entry.name.startsWith('.'))continue;
        const path=join(dir,entry.name);let st;try{st=lstatSync(path);}catch{continue;}
        if(st.isSymbolicLink())continue;
        if(st.isDirectory()){walk(path,depth+1);continue;}
        if(!st.isFile()||st.size<16||!profile.extensions.includes(extname(entry.name).toLowerCase()))continue;
        found.push({name:entry.name,path:path.startsWith(real)?path.slice(real.length+1):entry.name,bytes:st.size});
      }
    }
    walk(real);
  }
  return found;
}
export function deliveryReadiness(villaId) {
  const profile=deliveryProfile(villaId);
  if(profile.id==='software') {
    const readiness=projectReadiness(Number(villaId));
    return {domain:profile.id,label:profile.label,verified:readiness.verified,status:readiness.status,blockers:readiness.blockers,checks:readiness.checks,artifacts:[],sourceFiles:readiness.sourceFiles};
  }
  const artifacts=outputs(Number(villaId),profile);
  const tasks=db.prepare('SELECT t.title,t.status,t.result,a.role AS reviewer_role FROM tasks t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.villa_id=?').all(Number(villaId));
  const review=tasks.find(t=>t.status==='DONE' && /\b(review|kritik|abnahme|qualit|pr[uü]fung|test)\b/i.test(t.title) && /\b(CRITIC|REVIEWER|TESTER|SECURITY)\b/i.test(t.reviewer_role||'') && String(t.result||'').trim().length>=20);
  const open=tasks.filter(t=>['PENDING','READY','RUNNING','REVIEW'].includes(t.status)).length;
  const failed=tasks.filter(t=>['FAILED','BLOCKED'].includes(t.status)).length;
  const blockers=[];
  if(!artifacts.length)blockers.push(`Kein finales ${profile.label}-Artefakt im Arbeitsbereich gefunden`);
  if(!review)blockers.push('Kein abgeschlossenes Review eines separaten Critic-, Reviewer- oder Tester-Agenten mit dokumentiertem Ergebnis');
  if(open)blockers.push(`${open} offene Aufgabe(n) verhindern die Abnahme`);
  if(failed)blockers.push(`${failed} fehlgeschlagene Aufgabe(n) müssen behoben oder begründet geschlossen werden`);
  return {domain:profile.id,label:profile.label,verified:blockers.length===0,status:blockers.length?'blocked':'verified',blockers,checks:{artifact:{status:artifacts.length?'passed':'missing'},review:{status:review?'passed':'missing'},openTasks:{status:open?'blocked':'passed'}},artifacts,sourceFiles:artifacts.length};
}
export function deliveryPhases(villaId) {
  const profile=deliveryProfile(villaId);
  return profile.id==='software'?null:profile.phases.map(([id,title,desc],i)=>({id,title,weight:[15,20,25,25,15][i],goal:desc,musts:[{key:id.toLowerCase(),role:i===3?'CRITIC':i===2?'CREATOR':'PLANNER',title,desc:`${desc} Abnahme: nachvollziehbare Datei, belegte Entscheidungen und explizite Prüfkriterien.`}]}));
}
