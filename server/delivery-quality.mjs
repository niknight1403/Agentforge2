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
  ]},
  document: { label:'Text / Dokument', extensions:['.md','.txt','.pdf','.docx','.odt','.rtf','.epub','.html'], phases:[
    ['BRIEF','Zielgruppe & Zweck','Lege Leser, Einsatz, Ton, Umfang und überprüfbare Kriterien fest.'],
    ['OUTLINE','Gliederung & Belege','Erstelle eine nachvollziehbare Gliederung und markiere belegpflichtige Aussagen.'],
    ['DRAFT','Vollständigen Text erstellen','Liefere einen vollständigen, nutzbaren Entwurf im passenden Zielformat.'],
    ['REVIEW','Text unabhängig prüfen','Prüfe Fakten, Verständlichkeit, Vollständigkeit, Rechte und sprachliche Qualität.'],
    ['DELIVERY','Dokument übergeben','Liefere die finale Datei und eine kurze Nutzungs- oder Änderungsnotiz.']
  ]},
  research: { label:'Recherche / Analyse', extensions:['.md','.txt','.pdf','.docx','.html','.csv','.xlsx','.pptx'], phases:[
    ['QUESTION','Fragestellung & Umfang','Definiere Fragestellung, Zielgruppe, Zeitraum und Entscheidung, die die Recherche stützen soll.'],
    ['SOURCES','Quellen & Belege','Sammle überprüfbare Quellen mit Datum und trenne Belege von Annahmen.'],
    ['ANALYSIS','Befunde auswerten','Vergleiche Befunde, Unsicherheiten, Gegenargumente und praktische Konsequenzen.'],
    ['REVIEW','Ergebnisse kritisch prüfen','Prüfe Quellenqualität, Rechenwege, Aktualität und unbelegte Schlussfolgerungen.'],
    ['DELIVERY','Bericht & Quellenliste','Liefere den Bericht mit Quellen, Datum, Grenzen und konkreten nächsten Schritten.']
  ]},
  data: { label:'Daten / Tabelle', extensions:['.csv','.tsv','.xlsx','.ods','.json','.parquet','.pdf','.html'], phases:[
    ['DATA_BRIEF','Datenziel & Schema','Definiere Eingaben, Felder, Einheiten, Zielgruppe und erwartete Ausgaben.'],
    ['DATA_SOURCE','Daten & Qualität','Dokumentiere Herkunft, Lizenz, fehlende Werte, Formate und Datenschutzgrenzen.'],
    ['ANALYSIS','Auswertung erstellen','Erzeuge die angeforderte Tabelle, Auswertung oder Visualisierung mit nachvollziehbaren Berechnungen.'],
    ['VALIDATION','Ergebnisse validieren','Prüfe Summen, Randfälle, Stichproben, Formeln und Reproduzierbarkeit unabhängig.'],
    ['DELIVERY','Datenartefakt übergeben','Liefere die finale Datei mit Spaltenbeschreibung, Annahmen und Aktualisierungsanleitung.']
  ]},
  business: { label:'Geschäft / Strategie', extensions:['.md','.pdf','.docx','.pptx','.xlsx','.csv','.html'], phases:[
    ['OBJECTIVE','Ziel & Entscheidung','Definiere Geschäftsziel, Zielgruppe, Entscheidung und messbare Erfolgssignale.'],
    ['EVIDENCE','Markt & Annahmen','Prüfe Marktbelege, Alternativen, Kosten und Annahmen mit Quellen oder klarer Kennzeichnung.'],
    ['MODEL','Umsetzbares Modell','Erstelle einen priorisierten Plan mit Verantwortlichkeiten, Aufwand, Risiken und Kennzahlen.'],
    ['REVIEW','Plan kritisch prüfen','Prüfe Machbarkeit, Zahlen, Abhängigkeiten, Risiken und Gegenargumente unabhängig.'],
    ['HANDOFF','Arbeitsplan übergeben','Liefere ein direkt nutzbares Entscheidungs- oder Umsetzungspaket mit nächsten Schritten.']
  ]},
  education: { label:'Lernen / Schulung', extensions:['.md','.pdf','.docx','.pptx','.html','.zip'], phases:[
    ['LEARNER','Lernende & Ziele','Definiere Zielgruppe, Vorkenntnisse und beobachtbare Lernziele.'],
    ['CURRICULUM','Lernpfad & Inhalte','Ordne Inhalte in aufeinander aufbauende Einheiten mit Beispielen und Übungen.'],
    ['MATERIAL','Material erstellen','Liefere vollständige, verständliche Lernmaterialien und passende Aufgaben.'],
    ['ASSESSMENT','Lernerfolg prüfen','Prüfe Aufgaben, Lösungen, Barrierefreiheit und die Zuordnung zu Lernzielen.'],
    ['DELIVERY','Kurs übergeben','Liefere den nutzbaren Kurs samt Ablauf, Materialien und Hinweisen für Lehrende.']
  ]},
  event: { label:'Ablauf / Veranstaltung', extensions:['.md','.pdf','.docx','.xlsx','.csv','.ics','.html'], phases:[
    ['PURPOSE','Ziel & Rahmen','Definiere Anlass, Teilnehmende, Ort/Format, Zeitrahmen, Budget und Erfolgskriterien.'],
    ['PLAN','Ablauf & Ressourcen','Erstelle Zeitplan, Zuständigkeiten, Materialbedarf und Abhängigkeiten.'],
    ['OPERATIONS','Durchführung vorbereiten','Liefere Checklisten, Kommunikation, Zugänglichkeit und einen realistischen Ablauf.'],
    ['CONTINGENCY','Risiken & Alternativen','Prüfe kritische Abhängigkeiten, Sicherheitsaspekte und konkrete Ausweichpläne.'],
    ['HANDOFF','Paket übergeben','Liefere ein vollständiges Organisationspaket mit finalen Terminen und offenen Entscheidungen.']
  ]},
  general: { label:'Allgemeines Projekt', extensions:['.md','.txt','.pdf','.docx','.odt','.rtf','.epub','.html','.csv','.tsv','.xlsx','.ods','.json','.pptx','.png','.jpg','.jpeg','.webp','.svg','.mp4','.webm','.mp3','.wav','.stl','.step','.stp','.obj','.gltf','.glb','.zip'], phases:[
    ['GOAL','Ziel & Abnahme','Kläre das gewünschte Ergebnis, Zielgruppe, Grenzen und überprüfbare Abnahmekriterien.'],
    ['PLAN','Plan & Abhängigkeiten','Zerlege das Vorhaben in konkrete Ergebnisse, Rollen, Abhängigkeiten und Prüfschritte.'],
    ['PRODUCTION','Ergebnis erstellen','Liefere das angeforderte nutzbare Artefakt im passenden Format, nicht nur einen Plan.'],
    ['REVIEW','Ergebnis unabhängig prüfen','Prüfe das Artefakt gegen die Abnahmekriterien und dokumentiere offene Grenzen.'],
    ['HANDOFF','Nutzbares Ergebnis übergeben','Liefere Dateien, kurze Anleitung, Annahmen und konkrete nächste Schritte.']
  ]}
};
const SOFTWARE_HINT = /\b(app|application|software|webseite|website|webapp|plattform|dashboard|api|saas|code|programm|tool|system|entwickel|implementier|generator)\b/i;
const PROJECT_TARGET = /\b(market research|market analysis|business plan|businessplan|operations plan|event plan|travel plan|app|application|software|anwendung|webapp|webseite|website|program|programm|tool|generator|editor|plattform|platform|dashboard|api|saas|code|system|video|film|clip|animation|reel|audio|musik|music|song|podcast|bild|bilder|grafik|graphic|logo|poster|pitch|praesentation|deck|hardware|prototyp|cad|roman|buch|book|novel|artikel|article|blog|bericht|report|guide|leitfaden|handbuch|dokumentation|documentation|whitepaper|essay|newsletter|research|recherche|studie|marktstudie|marktforschung|study|marktanalyse|wettbewerbsanalyse|data|daten|dataset|datensatz|spreadsheet|excel|tabelle|budget|analysis|business|geschaeftsplan|strategie|strategy|marketing|roadmap|plan|kurs|onlinekurs|course|training|lesson|unterricht|lehrplan|curriculum|tutorial|event|veranstaltung|workshop|konferenz|conference|reiseplan|ablaufplan|projekt|project)\b/i;

const PROFILE_ROLES = {
  image:['PLANNER','ARCHITECT','PROFI','CRITIC','INTEGRATOR'],
  video:['PLANNER','DOCUMENTER','PROFI','CRITIC','INTEGRATOR'],
  audio:['PLANNER','ARCHITECT','PROFI','CRITIC','INTEGRATOR'],
  pitch:['RESEARCHER','STRATEGIST','DOCUMENTER','CRITIC','INTEGRATOR'],
  invention:['PLANNER','ARCHITECT','PROFI','TESTER','INTEGRATOR'],
  document:['PLANNER','RESEARCHER','DOCUMENTER','CRITIC','INTEGRATOR'],
  research:['RESEARCHER','RESEARCHER','REASONER','CRITIC','DOCUMENTER'],
  data:['PLANNER','RESEARCHER','REASONER','TESTER','DOCUMENTER'],
  business:['PLANNER','RESEARCHER','BUSINESS','CRITIC','INTEGRATOR'],
  education:['PLANNER','RESEARCHER','DOCUMENTER','TESTER','INTEGRATOR'],
  event:['PLANNER','RESEARCHER','PLANNER','CRITIC','INTEGRATOR'],
  general:['PLANNER','ARCHITECT','WORKER','CRITIC','INTEGRATOR']
};

function foldProjectText(value) {
  return String(value || '').toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss');
}

function targetProfile(target) {
  const t=foldProjectText(target);
  if(/^(app|application|software|anwendung|webapp|webseite|website|program|programm|tool|generator|editor|plattform|platform|dashboard|api|saas|code|system)$/.test(t))return 'software';
  if(/^(video|film|clip|animation|reel|werbespot)$/.test(t))return 'video';
  if(/^(audio|musik|music|song|podcast|soundtrack|voiceover)$/.test(t))return 'audio';
  if(/^(bild|bilder|grafik|graphic|logo|poster|cover|thumbnail|illustration)$/.test(t))return 'image';
  if(/^(pitch|praesentation|deck)$/.test(t))return 'pitch';
  if(/^(hardware|prototyp|cad|erfindung)$/.test(t))return 'invention';
  if(/^(roman|buch|book|novel|artikel|article|blog|bericht|report|guide|leitfaden|handbuch|dokumentation|documentation|whitepaper|essay|newsletter)$/.test(t))return 'document';
  if(/^(market research|market analysis|research|recherche|studie|marktstudie|marktforschung|study|marktanalyse|wettbewerbsanalyse)$/.test(t))return 'research';
  if(/^(data|daten|dataset|datensatz|spreadsheet|excel|tabelle|budget|analysis)$/.test(t))return 'data';
  if(/^(business plan|businessplan|operations plan|business|geschaeftsplan|strategie|strategy|marketing|roadmap|plan)$/.test(t))return 'business';
  if(/^(kurs|onlinekurs|course|training|lesson|unterricht|lehrplan|curriculum|tutorial)$/.test(t))return 'education';
  if(/^(event plan|travel plan|event|veranstaltung|workshop|konferenz|conference|reiseplan|ablaufplan)$/.test(t))return 'event';
  if(/^(projekt|project)$/.test(t))return 'general';
  return null;
}

export function classifyDeliverable(idea='') {
  const original=foldProjectText(idea);
  // Treat an editor/generator as software, not as the media it edits or creates.
  // The requested output still wins over later mentions such as "video about our app".
  const normalized=original
    .replace(/\b(?:audio|musik|music|video|bild|bilder|image|logo|report|bericht|text|dokument|document|dj)[- ]?app\b/g,'app')
    .replace(/\b(?:audio|musik|music|video|bild|bilder|image|logo|report|bericht|text|dokument|document)[- ]?(?:generator|editor|bearbeitungsprogramm)\b/g,'software');
  const action=/\b(?:develop\w*|build|create|entwickl\w*|erstelle?|baue?|programmier\w*|implementier\w*|produzier\w*|generier\w*|schreib\w*|write|plan\w*|analysier\w*|research\w*)\s+([^.!?\n]{0,180})/i.exec(normalized);
  const actionTarget=action?.[1].match(PROJECT_TARGET)?.[1];
  const actionClass=targetProfile(actionTarget);
  if(actionClass)return actionClass;

  // Without an action, prefer the first explicit product/result named in the brief.
  const heading=normalized.slice(0,800).match(PROJECT_TARGET)?.[1];
  const headingClass=targetProfile(heading);
  if(headingClass)return headingClass;

  if(/\b(?:market research|market analysis|research|recherche|studie|study|marktanalyse|wettbewerbsanalyse)\b/i.test(normalized))return 'research';
  if(/\b(?:dataset|datensatz|spreadsheet|excel|csv|tsv|datenanalyse|data analysis|daten|data)\b/i.test(normalized))return 'data';
  if(/\b(?:business plan|operations plan|event plan|geschaeftsplan|business|strategie|strategy|marketingplan|marketing plan|roadmap|umsatzplan)\b/i.test(normalized))return 'business';
  if(/\b(?:kurs|course|training|lesson|unterricht|lehrplan|curriculum|tutorial|schulung)\b/i.test(normalized))return 'education';
  if(/\b(?:event|veranstaltung|workshop|konferenz|conference|reiseplan|travel plan|ablaufplan)\b/i.test(normalized))return 'event';
  if(/\b(?:roman|buch|book|novel|artikel|article|blog|bericht|report|guide|leitfaden|handbuch|dokumentation|documentation|whitepaper|essay|newsletter)\b/i.test(normalized))return 'document';
  if(/\b(?:video|film|clip|animation|werbespot|reel)\b/i.test(normalized))return 'video';
  if(/\b(?:audio|musik|song|soundtrack|voiceover|podcast|jingle)\b/i.test(normalized))return 'audio';
  if(/\b(?:pitch|praesentation|pitchdeck|deck)\b/i.test(normalized))return 'pitch';
  if(/\b(?:erfindung|invention|prototyp|cad|produktentwicklung|hardware)\b/i.test(normalized))return 'invention';
  if(/\b(?:bild|bilder|bilderstellung|bildgenerierung|kampagnenbild|grafik|illustration|logo|poster|cover|thumbnail|visual|kunstwerk|artwork)\b/i.test(normalized))return 'image';
  if(SOFTWARE_HINT.test(normalized)||/\b(?:apk|aab|android[- ]app|ios[- ]app|flutter|gradle|react[- ]native)\b/i.test(normalized))return 'software';
  // Unknown briefs keep the stricter, independently executable software gate.
  // A general artifact workflow must be explicit; ambiguity must not weaken acceptance.
  return 'software';
}
/** Erwartete Datei-Endungen je Lieferklasse (leer bei Software). */
export function deliverableExtensions(id) {
  const profile = PROFILES[id];
  return Array.isArray(profile?.extensions) ? [...profile.extensions] : [];
}

export function deliveryProfile(villaId, ideaOverride) {
  const villa=db.prepare('SELECT idea,name FROM villas WHERE id=?').get(Number(villaId));
  const id=classifyDeliverable(typeof ideaOverride==='string'?ideaOverride:(villa?.idea || villa?.name || ''));
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
export function deliveryPhases(villaId, ideaOverride) {
  const profile=deliveryProfile(villaId,ideaOverride);
  return profile.id==='software'?null:profile.phases.map(([id,title,desc],i)=>{
    const role=PROFILE_ROLES[profile.id]?.[i]||'WORKER';
    return {id,title,weight:[15,20,25,25,15][i],goal:desc,role,musts:[{key:id.toLowerCase(),role,title,desc:`${desc} Abnahme: nachvollziehbare Datei, belegte Entscheidungen und explizite Prüfkriterien.`}]};
  });
}
