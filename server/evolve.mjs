/*
 * Villa-Evolution (v1.30): Jede Villa plant ihre Zukunft selbst.
 *
 * Ablauf je Villa
 *   1. ENTWICKLUNG   — die Villa arbeitet ihre aktuellen Phasen/Aufgaben ab.
 *   2. NAECHSTE PHASEN — sind alle Aufgaben erledigt, schlaegt die Villa
 *      selbst die naechsten Phasen vor (Status 'pending'). Nach Bestaetigung
 *      durch den Besitzer werden sie zu echten Aufgaben und die Villa
 *      entwickelt weiter. So lange, bis alle noetigen Phasen fertig sind.
 *   3. PERFEKTION    — danach schlaegt die Villa Schritte vor, um ihr Projekt
 *      zu perfektionieren, zu optimieren und optimal fertigzustellen
 *      (wieder mit Bestaetigung).
 *   4. MARKETPLACE   — zusaetzlich bekommt jede Villa einen eigenen
 *      AI-Marketplace-Vorschlag (Erweiterung des Projekts, kein Fremdprojekt).
 *
 * Nichts passiert ohne Besitzer-Entscheidung: Vorschlaege bleiben 'pending',
 * bis sie bestaetigt oder abgelehnt werden. Pro Villa liegt hoechstens ein
 * offener Vorschlag je Art vor, damit nichts aufgestaut wird.
 */
import { db, now } from './db.mjs';
import { estimateTaskEta, MAX_TASK_SAMPLE_MS } from './task-eta.mjs';
import { chat as realChat } from './llm.mjs';
import { maturity } from './product.mjs';
import { villaDir, detectProject } from './builds.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Arten von Villa-Vorschlaegen. */
export const KINDS = ['NEXT_PHASES', 'PERFECT', 'MARKETPLACE', 'REVENUE', 'BIG_IDEA', 'REPAIR'];
/** Nach so vielen bestaetigten Phasen-Runden gilt die Entwicklung als vollstaendig. */
export const MAX_PHASE_ROUNDS = 6;

db.exec(`
  CREATE TABLE IF NOT EXISTS villa_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    villa_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    items TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    round INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_vp_villa ON villa_proposals (villa_id, status);
`);

/** Endprodukt-Spalte fuer Umsatz-Vorschlaege - erst NACH der Tabellenanlage. */
{
  const cols = db.prepare('PRAGMA table_info(villa_proposals)').all().map((c) => c.name);
  if (!cols.includes('extra')) db.exec("ALTER TABLE villa_proposals ADD COLUMN extra TEXT NOT NULL DEFAULT ''");
}

let chatFn = realChat;
/** Nur fuer Tests: LLM-Aufruf ersetzen. */
export function _setChat(fn) { chatFn = fn || realChat; }

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const OPEN = ['PENDING', 'READY', 'RUNNING', 'REVIEW'];

/** Zustand einer Villa: offene Aufgaben, Fortschritt, Phase der Evolution. */
export function evolutionState(villaId) {
  const villa = db.prepare('SELECT id, name, idea, status FROM villas WHERE id = ?').get(villaId);
  if (!villa) return null;
  const q = (sql, ...a) => db.prepare(sql).get(...a).c;
  const open = q(`SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`, villaId, ...OPEN);
  const done = q("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status = 'DONE'", villaId);
  const failed = q("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status = 'FAILED'", villaId);
  const rounds = q("SELECT COUNT(*) c FROM villa_proposals WHERE villa_id = ? AND kind = 'NEXT_PHASES' AND status = 'approved'", villaId);
  const pendingKinds = db.prepare("SELECT kind FROM villa_proposals WHERE villa_id = ? AND status = 'pending'").all(villaId).map((r) => r.kind);
  const mt = maturity(villaId);
  const phasesComplete = mt.phases.every((p) => p.ratio >= 1);
  // Ehrlichkeit: 'erledigt' ist nur dann echte Entwicklung, wenn Dateien im Workspace liegen.
  let workspaceEmpty = true;
  try { workspaceEmpty = detectProject(villaDir(villaId)) === 'empty'; } catch { workspaceEmpty = true; }
  // Studio-Anbindung (Phase 2/3): Hat der Workspace schon eine lauffaehige
  // Web-App? Nur dann zeigen Live-Vorschau und APK-Baustrasse den echten
  // Produktstand; andernfalls plant der Sprint-Planer den Web-Build ein.
  let webBuild = false;
  try {
    const dir = villaDir(villaId);
    webBuild = ['dist/index.html', 'dist/public/index.html', 'build/index.html', 'out/index.html', 'public/index.html', 'index.html']
      .some((c) => existsSync(join(dir, c)));
  } catch { webBuild = false; }
  const developmentComplete = phasesComplete && rounds >= MAX_PHASE_ROUNDS && mt.readiness.verified;
  let stage = 'DEVELOPING';
  if (open === 0 && done > 0) stage = developmentComplete ? 'PERFECTING' : 'PLANNING_NEXT';
  // ETA + aktuelle Arbeit: der Nutzer sieht, was laeuft und wie lange es dauert.
  const durations = open ? db.prepare("SELECT duration_ms FROM tasks WHERE villa_id=? AND status='DONE' AND duration_ms>0 AND duration_ms<=? ORDER BY updated_at DESC LIMIT 20").all(villaId, MAX_TASK_SAMPLE_MS).map(row => row.duration_ms) : [];
  const eta = estimateTaskEta(open, durations, process.env.VF_MAX_CONCURRENCY);
  const current = db.prepare("SELECT title FROM tasks WHERE villa_id = ? AND status = 'RUNNING' ORDER BY updated_at ASC LIMIT 2").all(villaId).map((r) => String(r.title).slice(0, 70));
  return { villa, open, done, failed, rounds, pendingKinds, maturity: mt, phasesComplete, developmentComplete, workspaceEmpty, webBuild, stage, ...eta, currentTasks: current };
}

function villaBrief(st) {
  const tasks = db.prepare(
    "SELECT title, status, substr(result, 1, 160) r FROM tasks WHERE villa_id = ? ORDER BY id DESC LIMIT 14"
  ).all(st.villa.id);
  // Lessons Learned (Verifikationsausgaben, Reviews, Fehler) machen Vorschlaege
  // konkret statt generisch: der Planer kennt die echten Baustellen.
  const lessons = db.prepare(
    "SELECT title, substr(content, 1, 220) c FROM memories WHERE villa_id = ? AND kind IN ('LESSON','CONSTRAINT') ORDER BY id DESC LIMIT 4"
  ).all(st.villa.id).map((l) => `- (${l.title}) ${l.c}`);
  // Fehlgeschlagene Aufgaben (inkl. Fehlerursache) - der Heiler sieht die
  // echten Baustellen, bevor er einen Reparaturplan schreibt.
  const failed = db.prepare(
    "SELECT title, substr(result, 1, 200) r FROM tasks WHERE villa_id = ? AND status = 'FAILED' ORDER BY updated_at DESC LIMIT 5"
  ).all(st.villa.id).map((t) => `- FEHLGESCHLAGEN: ${t.title}${t.r ? ' | Ursache: ' + t.r : ''}`);
  return [
    `Villa "${st.villa.name}" (Reife ${st.maturity.score}/100 - ${st.maturity.stage}, aktuelle Phase ${st.maturity.currentPhase}).`,
    ...(failed.length ? ['FEHLER-ANALYSE (fehlgeschlagene Aufgaben):', ...failed] : []),
    `Projektidee: ${String(st.villa.idea || '').slice(0, 700)}`,
    `Bisher: ${st.done} Aufgaben erledigt, ${st.failed} fehlgeschlagen, ${st.rounds} Phasen-Runden bestaetigt.`,
    `Web-Build (lauffaehige Web-App im Workspace): ${st.webBuild ? 'vorhanden' : 'FEHLT - wichtig fuer Live-Vorschau und APK-Auslieferung'}.`,
    'Letzte Aufgaben:',
    ...tasks.map((t) => `- [${t.status}] ${t.title}${t.r ? ': ' + t.r : ''}`),
    'Wichtige Erkenntnisse aus Verifikation und Reviews (beruecksichtigen!):',
    ...lessons
  ].join('\n');
}

const FORMAT = '{"title": "kurzer Titel", "summary": "2-3 Saetze: warum genau diese Schritte jetzt", "items": [{"title": "Aufgabentitel", "description": "konkret, mit Akzeptanzkriterium", "role": "CODER|TESTER|REVIEWER|GROWTH|BUSINESS|ARCHITECT|CRITIC|DOCUMENTER"}]}';

const PROMPTS = {
  NEXT_PHASES: (st) => [
    'Du bist der Sprint-Planer einer Villa in einem autonomen App-Entwicklungssystem.',
    'Alle Aufgaben des letzten Sprints sind erledigt. Plane den NAEECHSTEN SPRINT: 3 bis 5 aufeinander aufbauende Aufgaben, die das Projekt sichtbar weiterbringen.',
    'Regeln:',
    '- Jeder Titel beginnt mit einem Zielwort (Bauen/Testen/Verbessern/Integrieren/Absichern/Veroeffentlichen), kein Bulletpoint-Deutsch.',
    '- CODER-Aufgaben nennen das konkrete Artefakt (Datei/Modul) im Akzeptanzkriterium: "Akzeptanz: Datei X tut Y, Start ohne Fehler".',
    '- Keine Wiederholung erledigter Aufgaben (siehe Aufgabenliste) - pruefe gegen die Erkenntnisse.',
    '- FEHLT der Web-Build (siehe Status), gehoert ZWINGEND eine CODER-Aufgabe in den Sprint: eine ohne Server lauffaehige index.html mit den Kernfunktionen des Produkts (auch als Build-Skript, das dist/index.html erzeugt, erfuellt). Akzeptanz: index.html oeffnet im Browser ohne Fehler.',
    '- summary nennt das Sprint-ZIEL in einem Satz und den messbaren Fortschritt.',
    'Antworte NUR mit JSON: ' + FORMAT, 'Alles auf Deutsch.'
  ].join('\n'),
  PERFECT: (st) => [
    'Du bist der Qualitaetsarchitekt einer Villa. Die Entwicklung ist vollstaendig abgeschlossen.',
    'Plane den PERFEKTIONIERUNGS-SRINT: 3 bis 5 Schritte mit messbarem Akzeptanzkriterium aus genau diesen Bereichen: Codequalitaet (Refactoring, Fehlerbehandlung), Performance (Ladezeit, Bundle-Groesse), Sicherheit (Eingabevalidierung, Geheimnisse), Nutzererlebnis (Bedienbarkeit, Feedback), Veroeffentlichungsreife (README, Startanleitung, Demo).',
    'Jeder Schritt nennt die Zahl im Akzeptanzkriterium (z.B. "Akzeptanz: Ladezeit < 2 s" oder "Akzeptanz: alle Tests gruen, 0 offene Fehler").',
    'summary nennt, was am Ende messbar besser ist als vorher.',
    'Antworte NUR mit JSON: ' + FORMAT, 'Alles auf Deutsch.'
  ].join('\n'),
  REPAIR: (st) => [
    'Du bist der autonome Fehler-Heiler einer Villa. In dieser Villa sind Aufgaben FEHLGESCHLAGEN (siehe Analyse unten).',
    'Erstelle einen REPARATURPLAN, der das KOMPLETTE Problem loest, damit es NICHT WIEDER passiert.',
    'Antworte NUR mit JSON:',
    '{"title": "Reparatur: kurze Ursache", "summary": "Root Cause und warum die Loesung dauerhaft ist", "items": [{"title": "...", "description": "konkreter Schritt mit Akzeptanzkriterium", "role": "CODER|TESTER|REVIEWER|ARCHITECT"}]}',
    'Regeln:',
    '- items = 2 bis 4 Schritte: (1) Root Cause beheben, (2) Pruefung/Test, der den Fehler ABFANGT, (3) Vorbeugung (Guard/Retry/Timeout), damit er nicht wiederkehrt.',
    '- Beziehe dich auf die konkreten Fehlermeldungen und Aufgaben. Keine Allgemeinplaetze.',
    'Alles auf Deutsch.'
  ].join('\n'),
  REVENUE: (st) => [
    'Du bist der Verkaufs-Stratege einer Villa. Das Projekt existiert bereits.',
    'Erstelle den WEG ZUM UMSATZ fuer genau dieses Projekt. Antworte mit JSON:',
    '{"endProduct": "1-2 Saetze: WAS genau am Ende verkauft wird (verkaufsfertiges Produkt, konkret)", "title": "kurzer Titel", "summary": "Zielkunden, Preismodell mit konkreter Zahl in EUR, Verkaufskanaele und SINNVOLLE Verkaufspartner", "items": [{"title": "...", "description": "konkreter Schritt mit Akzeptanzkriterium", "role": "BUSINESS|GROWTH|CODER|DOCUMENTER"}]}',
    'Regeln:',
    '- items = 3 bis 5 konkrete, JETZT machbare Schritte bis zum ersten Umsatz (z.B. Landingpage mit Preis, Zahlungslink einbauen, Verkaufstext, Pitch an konkrete Partner-Typen).',
    '- endProduct nennt das verkaufsfertige Endergebnis praezise (z.B. "Verkaufsfertige Android-App als Abo mit Zahlungsanbindung, 9,90 EUR/Monat").',
    '- summary nennt Zielkunden, Preis in EUR und 3 konkrete Verkaufspartner oder -kanaele mit Namen oder Typ.',
    '- Alles konkret und auf dieses Projekt bezogen, kein Geschwaetz.',
    'Antworte NUR mit dem JSON.', 'Alles auf Deutsch.'
  ].join('\n'),
  BIG_IDEA: (st) => [
    'Du bist der Produkt-Stratege einer Villa. Kernidee des Projekts: ' + String(st.villa?.idea || '').slice(0, 600),
    'Frage: Gibt es ein WEITAUS umsatzstaerkeres und besseres Produkt auf Basis dieser Kernidee? Wenn ja, schlage es vor. Wenn die Kernidee schon optimal ist, schlage die staerkste Monetarisierungs-Variante vor.',
    'Antworte NUR mit JSON:',
    '{"endProduct": "das neue Produkt in 1-2 Saetzen", "title": "Neue Idee: kurzer Name", "summary": "Warum diese Idee umsatzstaerker ist + geschaetztes Umsatzpotenzial in EUR je Monat + Zielkunden", "items": [{"title": "...", "description": "erster Umsetzungsschritt mit Akzeptanzkriterium", "role": "ARCHITECT|CODER|BUSINESS|GROWTH"}]}',
    'items = 3 bis 5 Schritte bis zum MVP des neuen Produkts.',
    'Alles auf Deutsch.'
  ].join('\n'),
  MARKETPLACE: (st) => [
    'Du bist der Marketplace-Stratege einer Villa. Schlage einen AI-Marketplace-Baustein vor, der DIESES Projekt erweitert (z. B. KI-Services, Plugins, Abo-/Paywall-Modell, API-Abrechnung), kein fremdes Projekt.',
    'Gib 3 bis 5 Umsetzungsschritte mit Akzeptanzkriterium und erklaere in summary, warum es sich fuer genau dieses Projekt lohnt.',
    'Antworte NUR mit JSON: ' + FORMAT, 'Alles auf Deutsch.'
  ].join('\n')
};

/** Normalisiert die Modellantwort zu pruefbaren Aufgaben-Eintraegen. */
export function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const it of items.slice(0, 6)) {
    const title = String(it?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const description = String(it?.description || '').trim().slice(0, 1200);
    if (title.length < 6 || description.length < 15) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, description, role: String(it?.role || 'CODER').toUpperCase().slice(0, 20) });
  }
  return out;
}

/**
 * Regelbasierter Notfall-Plan, wenn kein Modell erreichbar ist (Offline-Planer
 * oder erschoepfte Kontingente). Die Villa bleibt so nie stehen: es entsteht
 * ein brauchbarer, ehrlich gekennzeichneter Vorschlag, den der Besitzer
 * pruefen kann. Kein Raten ueber das Projekt - nur generische, sichere Schritte.
 */
export function fallbackPlan(kind, st) {
  const code = st.workspaceEmpty
    ? [{ title: 'Projektgeruest mit Startdatei anlegen', description: 'Lauffaehiges Grundgeruest im Projektordner anlegen (Startdatei, Abhaengigkeiten, README mit Startanleitung). Akzeptanz: Projekt startet lokal ohne Fehler.', role: 'CODER' }]
    : [];
  const web = (!st.workspaceEmpty && !st.webBuild)
    ? [{ title: 'Web-App als lauffaehige index.html bauen', description: 'Lauffaehige Web-App des Produkts als index.html im Projektordner anlegen (alternativ Build-Skript, das dist/index.html erzeugt). Akzeptanz: index.html laedt im Browser ohne Fehler und zeigt die Kernfunktionen.', role: 'CODER' }]
    : [];
  const plans = {
    NEXT_PHASES: [
      ...code,
      ...web,
      { title: 'Kernfunktionen als lauffaehigen Code umsetzen', description: 'Die wichtigsten Funktionen der Projektidee als echte Dateien im Projektordner implementieren. Akzeptanz: Funktionen laufen, Build ohne Fehler.', role: 'CODER' },
      { title: 'Tests fuer Kernfunktionen schreiben', description: 'Automatisierte Tests inkl. Fehlerfaelle. Akzeptanz: Testlauf gruen, mindestens 10 Faelle.', role: 'TESTER' },
      { title: 'Code-Review und Sicherheitspruefung', description: 'Fehlerbehandlung, Eingabepruefung, Geheimnisse. Akzeptanz: Fundstellenliste mit Behebung.', role: 'REVIEWER' }
    ],
    PERFECT: [
      { title: 'Leistung und Ladezeiten messen und verbessern', description: 'Engpaesse messen, die drei groessten beheben. Akzeptanz: Messwerte vorher/nachher.', role: 'CODER' },
      { title: 'Nutzerfluss und Fehlermeldungen polieren', description: 'Leere Zustaende, Fehlertexte, Ladeanzeigen pruefen. Akzeptanz: Checkliste ohne offene Punkte.', role: 'REVIEWER' },
      { title: 'Dokumentation und Veroeffentlichungs-Checkliste abschliessen', description: 'README, Schnellstart, Versionsstand, Release-Checkliste. Akzeptanz: Neuling startet das Projekt allein.', role: 'DOCUMENTER' }
    ],
    MARKETPLACE: [
      { title: 'Bezahlmodell und Preisstufen entwerfen', description: 'Abo-/Nutzungsmodell mit Preisstufen und Break-even. Akzeptanz: Preistabelle mit Annahmen.', role: 'BUSINESS' },
      { title: 'Erweiterungs-Schnittstelle fuer Plugins/Services definieren', description: 'Eine klare, dokumentierte Schnittstelle fuer Zusatz-Services. Akzeptanz: Beispiel-Plugin laeuft.', role: 'ARCHITECT' }
    ],
    REPAIR: [
      { title: 'Fehlerursache ermitteln und beheben', description: 'Die fehlgeschlagenen Aufgaben analysieren, Root Cause im Code/Setup beheben. Akzeptanz: Schritt laeuft ohne den urspruenglichen Fehler durch.', role: 'CODER' },
      { title: 'Guard gegen Wiederholung einbauen', description: 'Timeout, Pruefung oder Wiederholungslogik an der Fehlerstelle ergaenzen. Akzeptanz: Fehlerfall wird abgefangen statt abzustoerzen.', role: 'ARCHITECT' },
      { title: 'Regressionstest der reparierten Stelle', description: 'Test, der den urspruenglichen Fehlerfall abdeckt. Akzeptanz: Test gruen.', role: 'TESTER' }
    ],
    REVENUE: [
      { title: 'Landingpage mit Preis und Kauf-Button', description: 'Eine echte Landingpage (Vorteile, Preis, Zahlungslink) im Projektordner anlegen. Akzeptanz: Seite oeffnet im Browser, Preis sichtbar, Link klickbar.', role: 'CODER' },
      { title: 'Zahlungslink und Preismodell fertigstellen', description: 'Payment-Provider-Anbindung (z.B. Stripe- oder PayPal-Link) mit Preisstufe in EUR. Akzeptanz: Bezahl-Link funktioniert im Test.', role: 'BUSINESS' },
      { title: 'Verkaufstext und 3 Partner-Pitches schreiben', description: 'Praegnantes Verkaufsdokument plus drei konkrete Partner-Ansprachen. Akzeptanz: Dokument im Projektordner.', role: 'GROWTH' }
    ],
    BIG_IDEA: [
      { title: 'Umsatzstaerkere Variante der Kernidee bewerten', description: 'Kernidee analysieren, drei Monetarisierungs-Varianten mit Umsatzschaetzung vergleichen. Akzeptanz: Bewertungsdokument mit klarer Empfehlung.', role: 'BUSINESS' },
      { title: 'MVP-Geruest der staerksten Variante anlegen', description: 'Grundgeruest der empfohlenen Variante im Projektordner anlegen. Akzeptanz: Projekt startet ohne Fehler.', role: 'CODER' }
    ]
  };
  return {
    title: kind === 'PERFECT' ? 'Perfektionierung (Standardplan)' : kind === 'MARKETPLACE' ? 'Marketplace-Baustein (Standardplan)' : kind === 'REVENUE' ? 'Weg zum Umsatz (Standardplan)' : kind === 'BIG_IDEA' ? 'Neue Idee (Standardplan)' : 'Naechste Phase (Standardplan)',
    summary: 'Kein Sprachmodell erreichbar - dieser Vorschlag stammt aus dem regelbasierten Standardplan und ist bewusst allgemein gehalten.',
    items: plans[kind]
  };
}

/** Erzeugt einen Vorschlag der gegebenen Art fuer eine Villa (max. einer offen je Art). */
export async function proposeForVilla(villaId, kind) {
  if (!KINDS.includes(kind)) throw new Error('Unbekannte Vorschlagsart: ' + kind);
  const st = evolutionState(villaId);
  if (!st) throw new Error('Villa nicht gefunden');
  if (st.pendingKinds.includes(kind)) return { skipped: true, reason: 'Es wartet bereits ein Vorschlag dieser Art.' };

  const emptyNote = st.workspaceEmpty
    ? '\nWICHTIG: Der Projektordner der Villa ist LEER - bisher entstanden nur Berichte, keine Dateien. Mindestens die ersten zwei Aufgaben muessen echten Code/Dateien erzeugen (Rolle CODER, Akzeptanz: Dateien im Projektordner, lauffaehiger Start).'
    : '';
  const res = await chatFn(
    [{ role: 'system', content: PROMPTS[kind](st) + emptyNote }, { role: 'user', content: villaBrief(st) }],
    { role: 'PLANNER', strategy: 'FALLBACK', maxTokens: 900, timeoutMs: 90000 }
  );
  const raw = res.answer || res.text || res.content || '';
  let p = res.offline ? null : parseJson(raw);
  let items = normalizeItems(p?.items);
  let fromFallback = false;
  if (!p || !p.title || items.length === 0) {
    // Offline-Planer oder unbrauchbare Antwort: Standardplan statt stillem Stillstand.
    p = fallbackPlan(kind, st);
    items = normalizeItems(p.items);
    fromFallback = true;
  }

  // Ein echtes Modell-Ergebnis ersetzt ausstehende Standardplan-Vorschlaege
  // derselben Art: veraltete Notfall-Plaene vonfrueher bleiben nicht haengen.
  if (!fromFallback) {
    db.prepare(
      "DELETE FROM villa_proposals WHERE villa_id = ? AND kind = ? AND status = 'pending' AND (title LIKE '%Standardplan%' OR summary LIKE '%Standardplan%')"
    ).run(villaId, kind);
  }
  const round = st.rounds + 1;
  const info = db.prepare(
    'INSERT INTO villa_proposals (villa_id, kind, title, summary, items, status, round, created_at, extra) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(villaId, kind, String(p.title).slice(0, 200), String(p.summary || '').slice(0, 2000), JSON.stringify(items), 'pending', round, now(), String(p.endProduct || '').slice(0, 300));
  // Umsatz-Plan definiert das Endprodukt: als Vision auf die Villa schreiben,
  // damit die App ueberall zeigt, WAS am Ende verkauft wird.
  if (kind === 'REVENUE' && !fromFallback && p.endProduct) {
    db.prepare('UPDATE villas SET vision = ?, updated_at = ? WHERE id = ?')
      .run(String(p.endProduct).slice(0, 300), now(), villaId);
  }
  return { created: true, id: Number(info.lastInsertRowid), kind, items: items.length, fallback: fromFallback };
}

/** Welche Art Vorschlag ist fuer die Villa jetzt faellig? (null = keiner) */
export function dueKind(st) {
  if (!st || st.open > 0 || st.done === 0) return null;
  const kind = st.developmentComplete ? 'PERFECT' : 'NEXT_PHASES';
  return st.pendingKinds.includes(kind) ? null : kind;
}

/**
 * Ein Takt der Evolution fuer alle Villen. Gibt zurueck, was angelegt wurde.
 * Marketplace-Vorschlaege kommen nur, wenn die Villa mind. eine Phasen-Runde
 * abgeschlossen hat und noch keinen offenen Marketplace-Vorschlag besitzt.
 */
export async function evolveAll({ maxPerTick = 3 } = {}) {
  const made = [];
  const ids = db.prepare('SELECT id FROM villas WHERE autonomy != 0 ORDER BY id').all().map((r) => r.id);
  for (const id of ids) {
    if (made.length >= maxPerTick) break;
    const st = evolutionState(id);
    const kinds = [];
    const due = dueKind(st);
    if (due) kinds.push(due);
    if (st && st.open === 0 && st.done > 0 && st.rounds >= 1 && !st.pendingKinds.includes('MARKETPLACE')) kinds.push('MARKETPLACE');
    // Weg zum Umsatz: einmal je Villa, sobald erste Fortschritte da sind - der
    // Nutzer sieht frueh, WAS am Ende verkauft wird und welche Schritte bis zum
    // Umsatz fehlen.
    if (st && st.done > 0) {
      const revRows = db.prepare("SELECT status, title, summary FROM villa_proposals WHERE villa_id = ? AND kind = 'REVENUE'").all(id);
      // Ein echter Umsatz-Plan zaehlt; ein noch offener Standardplan (Offline-
      // Notfall) zaehlt NICHT - sobald ein Modell erreichbar ist, ersetzt der
      // Takt ihn automatisch durch einen konkreten Plan.
      const hasRealRevenue = revRows.some((r) => r.status !== 'pending' || (!String(r.title).includes('Standardplan') && !String(r.summary).includes('Standardplan')));
      if (!hasRealRevenue && !st.pendingKinds.includes('REVENUE')) kinds.push('REVENUE');
      // Neue Idee (Pivot): sobald der Umsatz-Plan bestaetigt ist, pruefen die
      // Agenten einmalig, ob eine umsatzstaerkere Software auf der Kernidee
      // aufbauen koennte.
      const revenueApproved = db.prepare("SELECT COUNT(*) c FROM villa_proposals WHERE villa_id = ? AND kind = 'REVENUE' AND status = 'approved'").get(id).c;
      const hasBigIdea = db.prepare("SELECT COUNT(*) c FROM villa_proposals WHERE villa_id = ? AND kind = 'BIG_IDEA'").get(id).c;
      if (revenueApproved > 0 && !hasBigIdea && !st.pendingKinds.includes('BIG_IDEA')) kinds.push('BIG_IDEA');
    }
    for (const kind of kinds) {
      if (made.length >= maxPerTick) break;
      try {
        const r = await proposeForVilla(id, kind);
        if (r.created) made.push({ villaId: id, ...r });
      } catch (e) { made.push({ villaId: id, kind, error: String(e.message || e).slice(0, 160) }); }
    }
  }
  return made;
}

export function listVillaProposals(villaId, { status = '' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM villa_proposals WHERE villa_id = ? AND status = ? ORDER BY id DESC LIMIT 30').all(villaId, status)
    : db.prepare("SELECT * FROM villa_proposals WHERE villa_id = ? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 30").all(villaId);
  return rows.map((r) => ({
    id: r.id, villaId: r.villa_id, kind: r.kind, title: r.title, summary: r.summary,
    items: JSON.parse(r.items || '[]'), status: r.status, round: r.round,
    createdAt: r.created_at, decidedAt: r.decided_at
  }));
}

/** Alle offenen Vorschlaege ueber alle Villen (fuer die App-Uebersicht). */
export function listAllPending() {
  return db.prepare(
    `SELECT p.*, v.name AS villa_name FROM villa_proposals p JOIN villas v ON v.id = p.villa_id
     WHERE p.status = 'pending' AND v.status != 'ARCHIVED' ORDER BY p.id DESC LIMIT 50`
  ).all().map((r) => ({
    id: r.id, villaId: r.villa_id, villaName: r.villa_name, kind: r.kind, title: r.title,
    summary: r.summary, items: JSON.parse(r.items || '[]'), round: r.round, createdAt: r.created_at
  }));
}

/** Besitzer bestaetigt: die Eintraege werden zu echten, priorisierten Aufgaben. */
export function approveVillaProposal(id) {
  // Atomarer Claim gegen Doppel-Bestaetigung.
  const claim = db.prepare("UPDATE villa_proposals SET status = 'approving' WHERE id = ? AND status = 'pending'").run(Number(id));
  if (claim.changes === 0) throw new Error('Vorschlag nicht (mehr) offen.');
  const row = db.prepare('SELECT * FROM villa_proposals WHERE id = ?').get(Number(id));
  try {
    const items = JSON.parse(row.items || '[]');
    const existing = db.prepare('SELECT title FROM tasks WHERE villa_id = ?').all(row.villa_id).map((t) => t.title.toLowerCase());
    const tag = row.kind === 'PERFECT' ? 'PERFEKT' : row.kind === 'MARKETPLACE' ? 'MARKET' : row.kind === 'REVENUE' ? 'UMSATZ' : row.kind === 'BIG_IDEA' ? 'PIVOT' : row.kind === 'REPAIR' ? 'REPARATUR' : `PHASE ${row.round}`;
    let added = 0;
    for (const it of items) {
      const title = `[${tag}] ${it.title}`.slice(0, 160);
      if (existing.includes(title.toLowerCase())) continue;
      db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(row.villa_id, title, `${it.description}\nRolle: ${it.role}.`, 'PENDING', row.kind === 'REPAIR' ? 7 : row.kind === 'PERFECT' ? 6 : row.kind === 'REVENUE' ? 5 : 4, now(), now());
      added++;
    }
    db.prepare("UPDATE villa_proposals SET status = 'approved', decided_at = ? WHERE id = ?").run(now(), Number(id));
    // Umsatz-Plan bestätigt: die Endprodukt-Vision wird jetzt garantiert auf
    // die Villa geschrieben (endProduct direkt, sonst aus dem Verkaufszusammen-
    // fassung - Zielkunden, Preis, Partner stehen dort).
    if (row.kind === 'REVENUE') {
      const v = db.prepare('SELECT id, vision FROM villas WHERE id = ?').get(row.villa_id);
      if (v && !v.vision) {
        const vision = String(row.extra || '').trim() || String(row.summary || '').slice(0, 200);
        if (vision) db.prepare('UPDATE villas SET vision = ?, updated_at = ? WHERE id = ?').run(vision, now(), row.villa_id);
      }
    }
    return { ok: true, villaId: row.villa_id, kind: row.kind, added };
  } catch (err) {
    db.prepare("UPDATE villa_proposals SET status = 'pending' WHERE id = ?").run(Number(id));
    throw err;
  }
}

export function rejectVillaProposal(id) {
  const info = db.prepare("UPDATE villa_proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(now(), Number(id));
  if (info.changes === 0) throw new Error('Vorschlag nicht (mehr) offen.');
  return { ok: true };
}
