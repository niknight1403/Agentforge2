import { db } from './db.mjs';

export function villaSuggestions(villaId) {
  const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(Number(villaId));
  if (!villa) return [];
  const tasks = db.prepare('SELECT * FROM tasks WHERE villa_id = ? ORDER BY priority ASC, id ASC').all(villa.id);
  const open = tasks.filter((t) => ['PENDING', 'READY', 'RUNNING', 'REVIEW'].includes(t.status));
  const failed = tasks.filter((t) => t.status === 'FAILED');
  const done = tasks.filter((t) => t.status === 'DONE');
  const suggestions = [];
  if (failed.length) suggestions.push({ id: 'recover-failed', title: 'Fehler zuerst beheben', priority: 1, rationale: `${failed.length} Aufgabe(n) sind fehlgeschlagen.`, prompt: 'Analysiere die fehlgeschlagenen Aufgaben, behebe die Ursachen und starte die betroffenen Schritte kontrolliert neu.' });
  if (open.length) suggestions.push({ id: 'next-task', title: 'Nächsten Schritt umsetzen', priority: 2, rationale: `${open.length} offene Aufgabe(n) warten.`, prompt: `Bearbeite als Nächstes die Aufgabe „${open[0].title}“ und liefere ein prüfbares Ergebnis.` });
  if (villa.source_path) suggestions.push({ id: 'quality-audit', title: 'Bestehendes Projekt auditieren', priority: 3, rationale: 'Ein Quellprojekt ist hinterlegt.', prompt: 'Analysiere das bestehende Projekt auf Architektur-, UI-, Sicherheits- und Testverbesserungen und erstelle einen priorisierten Plan.' });
  if (done.length >= 3) suggestions.push({ id: 'review-release', title: 'Qualitätssicherung durchführen', priority: 4, rationale: `${done.length} Aufgaben sind bereits erledigt.`, prompt: 'Prüfe die bisherigen Ergebnisse, führe die verfügbaren Tests aus und dokumentiere offene Risiken.' });
  suggestions.push({ id: 'business-case', title: 'Produkt- und Umsatzchance prüfen', priority: 5, rationale: 'Ein frischer Blick verhindert blinde Flecken.', prompt: 'Bewerte Zielgruppe, Nutzenversprechen, Preismodell und den schnellsten realistischen Validierungsschritt.' });
  return suggestions.slice(0, 5);
}
