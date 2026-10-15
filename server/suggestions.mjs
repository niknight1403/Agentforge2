import { createHash } from 'node:crypto';
import { db } from './db.mjs';
import { duplicateGroups } from './duplicates.mjs';
import { getSetting } from './control-store.mjs';
export function suggestions(villaId = null, isRunning = () => false) {
  const out = [];
  const add = (kind, title, reason, prompt, target = '') => {
    const id = createHash('sha256').update(JSON.stringify([kind, villaId, target, prompt])).digest('hex').slice(0, 20);
    out.push({ id, kind, title, reason, prompt, villaId });
  };
  if (villaId != null) {
    const villa = db.prepare('SELECT * FROM villas WHERE id=? AND status != ?').get(villaId, 'ARCHIVED');
    if (!villa) return [];
    const failed = db.prepare("SELECT id,title FROM tasks WHERE villa_id=? AND status IN ('FAILED','BLOCKED') ORDER BY priority,id LIMIT 1").get(villaId);
    if (failed) add('repair', 'Fehler gezielt beheben', `Aufgabe #${failed.id} ist fehlgeschlagen.`, `Analysiere den Fehler in Aufgabe #${failed.id} „${failed.title}“. Behebe die Ursache und prüfe das Ergebnis.`, failed.id);
    const pending = db.prepare("SELECT id,title,description FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY') ORDER BY priority,id LIMIT 12").all(villaId);
    const seen = new Set();
    for (const task of pending) {
      const key = task.title.trim().toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      add('next_task', task.title, 'Offene Aufgabe aus dem aktuellen Projektplan.', `Bearbeite Aufgabe #${task.id} „${task.title}“. ${String(task.description).slice(0, 350)} Liefere ein überprüfbares Ergebnis.`, task.id);
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
  return out.filter(s => !dismissed.has(s.id)).slice(0, getSetting('suggestionCount'));
}
