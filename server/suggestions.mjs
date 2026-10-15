import { db, now } from './db.mjs';

const OPEN = new Set(['PENDING', 'READY', 'RUNNING', 'REVIEW']);
const HIGH_RISK = new Set(['FAILED', 'BLOCKED']);

function suggestion({ id, title, category, priority, score, rationale, context, prompt, actionLabel = 'Im Chat starten' }) {
  return { id, title, category, priority, score, rationale, context, prompt, actionLabel };
}

/**
 * Liefert priorisierte Empfehlungen aus dem echten Villa-Kontext.
 * Die Funktion bleibt deterministisch und offline-fähig; LLMs können die
 * vorgeschlagenen Prompts anschließend im Entwicklungs-Chat ausführen.
 */
export function villaSuggestions(villaId) {
  const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(Number(villaId));
  if (!villa) return [];
  const tasks = db.prepare('SELECT * FROM tasks WHERE villa_id = ? ORDER BY priority ASC, id ASC').all(villa.id);
  const agents = db.prepare('SELECT status, is_root FROM agents WHERE villa_id = ?').all(villa.id);
  const latestMessage = db.prepare('SELECT role, content, created_at FROM messages WHERE villa_id = ? ORDER BY id DESC LIMIT 1').get(villa.id);
  const latestReport = db.prepare('SELECT kind, title, created_at FROM reports WHERE villa_id = ? ORDER BY id DESC LIMIT 1').get(villa.id);
  const open = tasks.filter((t) => OPEN.has(t.status));
  const failed = tasks.filter((t) => HIGH_RISK.has(t.status));
  const done = tasks.filter((t) => t.status === 'DONE');
  const runningAgents = agents.filter((a) => ['THINKING', 'RUNNING'].includes(a.status)).length;
  const idleAgents = agents.filter((a) => a.status === 'IDLE').length;
  const suggestions = [];

  if (failed.length) {
    suggestions.push(suggestion({
      id: 'recover-failed', title: 'Fehler zuerst beheben', category: 'Stabilität', priority: 1,
      score: 100 + failed.length * 5,
      rationale: `${failed.length} Aufgabe(n) brauchen Aufmerksamkeit, bevor neue Arbeit sinnvoll ist.`,
      context: [`${failed.length} fehlgeschlagene oder blockierte Aufgaben`, villa.status === 'PAUSED' ? 'Villa ist pausiert' : 'Lauf kann stabilisiert werden'],
      prompt: 'Analysiere die fehlgeschlagenen und blockierten Aufgaben, ordne die Ursachen nach Risiko und behebe zuerst den wichtigsten Fehler. Starte nichts blind neu.',
      actionLabel: 'Fehler analysieren'
    }));
  }
  if (open.length) {
    const next = open[0];
    suggestions.push(suggestion({
      id: 'next-task', title: 'Nächsten Schritt umsetzen', category: 'Ausführung', priority: 2,
      score: 82 + Math.max(0, 9 - Number(next.priority || 5)),
      rationale: `${open.length} offene Aufgabe(n); die höchste Priorität ist „${next.title}“.`,
      context: [`Priorität ${next.priority || 5}`, `${done.length}/${tasks.length} Aufgaben erledigt`, runningAgents ? `${runningAgents} Agent(en) arbeiten` : 'Kein Agent arbeitet gerade'],
      prompt: `Bearbeite als Nächstes die Aufgabe „${next.title}“. Prüfe zuerst vorhandene Ergebnisse, liefere ein prüfbares Ergebnis und markiere offene Risiken.`,
      actionLabel: 'Aufgabe anweisen'
    }));
  }
  if (villa.source_path) {
    suggestions.push(suggestion({
      id: 'quality-audit', title: 'Bestehendes Projekt auditieren', category: 'Qualität', priority: 3,
      score: 76,
      rationale: 'Ein Quellprojekt ist hinterlegt und kann gegen die aktuelle Zielidee geprüft werden.',
      context: [`Quellpfad: ${villa.source_path}`, latestReport ? `Letzter Bericht: ${latestReport.title}` : 'Noch kein Analysebericht'],
      prompt: 'Analysiere das bestehende Projekt auf Architektur-, UI-, Sicherheits- und Testverbesserungen. Vergleiche die Befunde mit der Villa-Idee und erstelle eine priorisierte Roadmap.',
      actionLabel: 'Audit starten'
    }));
  }
  if (done.length >= 3 || latestReport) {
    suggestions.push(suggestion({
      id: 'review-release', title: 'Qualitätssicherung durchführen', category: 'Review', priority: 4,
      score: 68 + Math.min(done.length, 10),
      rationale: `${done.length} Aufgaben sind abgeschlossen${latestReport ? ' und ein Ergebnisbericht liegt vor' : ''}.`,
      context: [`${done.length} erledigte Aufgaben`, latestReport ? `Bericht: ${latestReport.kind}` : 'Kein aktueller Bericht'],
      prompt: 'Prüfe die bisherigen Ergebnisse gegen die Villa-Idee, führe die verfügbaren Tests aus und dokumentiere konkrete Release-Blocker sowie den nächsten sicheren Schritt.',
      actionLabel: 'Review anfordern'
    }));
  }
  if (agents.length && idleAgents / agents.length > 0.75 && open.length) {
    suggestions.push(suggestion({
      id: 'increase-throughput', title: 'Agenten gezielter einsetzen', category: 'Effizienz', priority: 5,
      score: 61,
      rationale: `${idleAgents} von ${agents.length} Agenten sind verfügbar, während Aufgaben offen bleiben.`,
      context: [`${idleAgents} freie Agenten`, `${open.length} offene Aufgaben`],
      prompt: 'Prüfe, ob die offenen Aufgaben unabhängig parallelisiert werden können. Verteile nur klar abgegrenzte Arbeit und halte gemeinsame Abhängigkeiten explizit fest.',
      actionLabel: 'Parallelisierung prüfen'
    }));
  }
  if (latestMessage?.role === 'user' && now() - Number(latestMessage.created_at || 0) < 24 * 60 * 60_000) {
    suggestions.push(suggestion({
      id: 'follow-up-chat', title: 'Letzte Anweisung vertiefen', category: 'Kontext', priority: 6,
      score: 55,
      rationale: 'Die letzte Nachricht stammt vom Nutzer und hat noch keinen Folgeimpuls.',
      context: [`Letzte Anweisung: ${String(latestMessage.content).slice(0, 100)}`],
      prompt: 'Greife meine letzte Anweisung auf, fasse den aktuellen Stand knapp zusammen und schlage genau eine konkrete, reversible nächste Aktion vor.',
      actionLabel: 'Kontext fortsetzen'
    }));
  }
  suggestions.push(suggestion({
    id: 'business-case', title: 'Produkt- und Umsatzchance prüfen', category: 'Strategie', priority: 7,
    score: 40,
    rationale: 'Ein strategischer Check hält Nutzenversprechen und Zielgruppe sichtbar.',
    context: [villa.idea ? `Ziel: ${String(villa.idea).slice(0, 120)}` : 'Keine Zielbeschreibung'],
    prompt: 'Bewerte Zielgruppe, Nutzenversprechen, Preismodell und den schnellsten realistischen Validierungsschritt für diese Villa.',
    actionLabel: 'Strategie prüfen'
  }));
  return suggestions.sort((a, b) => b.score - a.score || a.priority - b.priority).slice(0, 5);
}
