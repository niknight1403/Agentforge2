import { createHash } from 'node:crypto';
import { db } from './db.mjs';
import { duplicateGroups } from './duplicates.mjs';
import { getSetting } from './control-store.mjs';
import { deliveryReadiness, deliveryProfile } from './delivery-quality.mjs';
export function suggestions(villaId = null, isRunning = () => false) {
  const out = [];
  const add = (kind, title, reason, prompt, target = '', details = {}) => {
    const id = createHash('sha256').update(JSON.stringify([kind, villaId, target, prompt])).digest('hex').slice(0, 20);
    out.push({ id, kind, title, reason, prompt, villaId, domain:details.domain||'', priority:details.priority||'normal', impact:details.impact||'Projektfortschritt', effort:details.effort||'mittel', acceptance:details.acceptance||'Ergebnisdatei oder nachvollziehbarer Prüfbericht mit überprüfbarem Abnahmekriterium.' });
  };
  if (villaId != null) {
    const villa = db.prepare('SELECT * FROM villas WHERE id=? AND status != ?').get(villaId, 'ARCHIVED');
    if (!villa) return [];
    const profile = deliveryProfile(villaId);
    const quality = deliveryReadiness(villaId);
    if (!quality.verified && quality.blockers?.length) {
      const blocker=quality.blockers[0];
      const task=profile.phases?.find(([id])=>id==='REVIEW')?.[1] || 'Qualität und Abnahme verbessern';
      add('quality', quality.artifacts?.length ? 'Ergebnis professionell prüfen' : `${profile.label}-Ergebnis fertigstellen`, blocker,
        `Arbeite in der Villa #${villaId} (${profile.label}) zuerst am konkreten Abnahmehindernis: ${blocker}. Verwende die passende Aufgabenphase „${task}“. Liefere das echte finale Artefakt, prüfe es unabhängig gegen Zielgruppe, technische Qualität und Nutzbarkeit, behebe kritische Befunde und dokumentiere die Abnahme. Erfolg: ${quality.blockers.length===1?'alle Qualitätsblocker beseitigt':'Blockerliste auf null; finales Artefakt und dokumentiertes Review vorhanden'}. Keine Fertigmeldung ohne Nachweis.`,
        'delivery-quality', {domain:profile.id,priority:'hoch',impact:'Abnahme & Ergebnisqualität',effort:'zielgerichtet',acceptance:quality.artifacts?.length?'Finales Artefakt, dokumentiertes Review mit Befunden/Fixes und keine offenen Aufgaben.':'Finale Datei im passenden Format plus dokumentiertes unabhängiges Review und keine offenen Aufgaben.'});
    }
    const failed = db.prepare("SELECT id,title FROM tasks WHERE villa_id=? AND status IN ('FAILED','BLOCKED') ORDER BY priority,id LIMIT 1").get(villaId);
    if (failed) add('repair', 'Fehler gezielt beheben', `Aufgabe #${failed.id} ist fehlgeschlagen.`, `Analysiere den Fehler in Aufgabe #${failed.id} „${failed.title}“. Behebe die Ursache, dokumentiere die Korrektur und führe die betroffene Abnahme erneut aus.`, failed.id, {domain:profile.id,priority:'kritisch',impact:'Stabilität & Qualität'});
    const pending = db.prepare("SELECT id,title,description FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY') ORDER BY priority,id LIMIT 12").all(villaId);
    const seen = new Set();
    for (const task of pending) {
      const key = task.title.trim().toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      add('next_task', task.title, 'Offene Aufgabe aus dem aktuellen Projektplan.', `Bearbeite Aufgabe #${task.id} „${task.title}“. ${String(task.description).slice(0, 350)} Liefere ein überprüfbares Ergebnis.`, task.id, {domain:profile.id,priority:'mittel',impact:'Nächster Projektmeilenstein',acceptance:String(task.description||'').match(/Akzeptanz:[^\n.]*(?:\.[^\n.]*)?/i)?.[0]||'Überprüfbares Ergebnisartefakt mit kurzer Abnahme.'});
    }
    if (!failed && !pending.length) add('verify', 'Ergebnisse verifizieren', 'Keine offenen Aufgaben im aktuellen Plan.', `Prüfe die tatsächlichen Ergebnisse von Villa #${villaId}. Nenne belegbare Lücken und konkrete Abnahmekriterien, statt einen neuen Standardplan zu erzeugen.`);
  } else {
    const duplicates = duplicateGroups(isRunning);
    if (duplicates.length) add('cleanup', 'Doppelte Villen aufräumen', `${duplicates.length} Gruppen mit gleichem Namen, Ziel und Quellpfad.`, 'Archiviere die doppelten Villen und behalte alle Arbeitsstände.');
    const villas = db.prepare("SELECT v.id,v.name,COUNT(t.id) AS failed FROM villas v JOIN tasks t ON t.villa_id=v.id WHERE t.status='FAILED' AND v.status != 'ARCHIVED' GROUP BY v.id ORDER BY failed DESC,v.id LIMIT 3").all();
    for (const v of villas) add('repair', `${v.name}: Fehler prüfen`, `${v.failed} fehlgeschlagene Aufgaben.`, `Zeige Status und nächste Schritte für Villa #${v.id}.`, v.id);
    const skills = db.prepare('SELECT COUNT(*) c FROM control_skills WHERE enabled=1').get().c;
    if (!skills) add('skill', 'Arbeitsweise festlegen', 'Noch kein eigener Skill aktiviert.', 'Erstelle einen Skill mit dem Titel Qualitätsprüfung: Jede Änderung braucht konkrete Abnahmekriterien, Fehlerzustände und eine passende Prüfung.');
    add('status', 'Gesamtüberblick', 'Aktuelle Villen, Werkzeuge und Konfiguration prüfen.', 'Status');
  }
  const dismissed = new Set(db.prepare('SELECT id FROM control_dismissals').all().map(r => r.id));
  const priority={kritisch:0,hoch:1,mittel:2,normal:3};
  return out.filter(s => !dismissed.has(s.id)).sort((a,b)=>(priority[a.priority]??3)-(priority[b.priority]??3)).slice(0, getSetting('suggestionCount'));
}
