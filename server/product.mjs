import { ensureVerificationTasks } from './project-verification.mjs';
/**
 * Produkt-Pipeline: von der Idee zum marktreifen Produkt, 24/7.
 *
 * Bausteine
 *  1. PHASEN        — feste Lebenszyklus-Stufen (Discovery bis Launch/Betrieb).
 *                     Jede Phase hat Pflicht-Artefakte, die der Rat prueft.
 *  2. Marktreife    — Score 0-100 je Villa aus erledigten Pflicht-Aufgaben,
 *                     Berichten und Tests; sichtbar in /api/villas/:id/product.
 *  3. Rat → Aufgaben — Rat-Vorschlaege werden zu echten, priorisierten Aufgaben
 *                     (kein reiner Gespraechsstoff mehr), dedupliziert.
 *  4. Dauer-Loop    — erledigte Villen werden nie "fertig": der Hub startet
 *                     sie neu, sobald Kontingente frei sind, und plant die
 *                     naechste Verbesserungswelle (Qualitaet, Wachstum, Umsatz).
 *
 * Alles bleibt innerhalb der Free-Tier-Grenzen: der Loop drosselt sich selbst
 * (max. 1 Wave je Villa pro Zyklus, Pause bei erschoepften Routen).
 */
import { db, now } from './db.mjs';
import { deliveryPhases, deliveryProfile, deliveryReadiness } from './delivery-quality.mjs';

/** Lebenszyklus-Phasen mit Pflicht-Aufgaben (Titel-Stichworte pruefen die Abdeckung). */
export const PHASES = [
  {
    id: 'DISCOVERY', title: 'Discovery & Validierung', weight: 15,
    goal: 'Problem, Zielgruppe und Wettbewerb belegen; Zahlungsbereitschaft pruefen.',
    musts: [
      { key: 'markt', role: 'RESEARCHER', title: 'Marktanalyse & Wettbewerber', desc: 'Zielgruppe, Marktgroesse, 5 Wettbewerber mit Staerken/Schwaechen. Akzeptanz: Bericht mit Quellen und Luecken-Analyse.' },
      { key: 'zielgruppe', role: 'BUSINESS', title: 'Zielgruppen- und Preismodell', desc: 'Personas, Zahlungsbereitschaft, Preismodell, Marge. Akzeptanz: Preistabelle mit Annahmen und Break-even.' }
    ]
  },
  {
    id: 'DESIGN', title: 'Produktdesign & Architektur', weight: 15,
    goal: 'Funktionsumfang (MVP), UX-Fluss und technische Architektur festlegen.',
    musts: [
      { key: 'mvp', role: 'PLANNER', title: 'MVP-Umfang & Roadmap', desc: 'Muss-/Kann-Features, Roadmap in 3 Releases. Akzeptanz: priorisierte Backlog-Liste mit Aufwand.' },
      { key: 'architektur', role: 'ARCHITECT', title: 'Architektur & Datenmodell', desc: 'Komponenten, Schnittstellen, Datenmodell, Deployment. Akzeptanz: Architekturdokument mit Diagramm in Textform.' }
    ]
  },
  {
    id: 'BUILD', title: 'Umsetzung (MVP)', weight: 30,
    goal: 'Lauffaehiges MVP mit sauberem Code und Fehlerbehandlung.',
    musts: [
      { key: 'code', role: 'CODER', title: 'MVP-Kernfunktionen implementieren', desc: 'Kernfeatures lauffaehig umsetzen. Akzeptanz: vollstaendige Dateien, Start- und Build-Anleitung.' },
      { key: 'review', role: 'REVIEWER', title: 'Code-Review & Sicherheitspruefung', desc: 'Sicherheit, Fehlerbehandlung, Lesbarkeit. Akzeptanz: Fundstellenliste mit Behebung.' }
    ]
  },
  {
    id: 'QUALITY', title: 'Qualitaet & Tests', weight: 15,
    goal: 'Automatisierte Tests, Randfaelle, Performance und Stabilitaet.',
    musts: [
      { key: 'tests', role: 'TESTER', title: 'Testsuite & Randfaelle', desc: 'Unit-/Integrationstests inkl. Fehlerszenarien. Akzeptanz: Testfaelle mit Eingabe/erwartetem Ergebnis.' },
      { key: 'doku', role: 'DOCUMENTER', title: 'Dokumentation & Onboarding', desc: 'Nutzer- und Betriebsdoku. Akzeptanz: README, Schnellstart, FAQ.' }
    ]
  },
  {
    id: 'LAUNCH', title: 'Markteinfuehrung', weight: 15,
    goal: 'Positionierung, Kanaele, Rechtliches und Launch-Plan.',
    musts: [
      { key: 'launch', role: 'GROWTH', title: 'Go-to-Market & Launch-Plan', desc: '90-Tage-Plan: Kanaele, Aktivierung, Messgroessen. Akzeptanz: Plan mit Aufwand und erwarteter Wirkung.' },
      { key: 'recht', role: 'BUSINESS', title: 'Rechtliches & Compliance', desc: 'Datenschutz (DSGVO), Impressum, AGB, Lizenzen. Akzeptanz: Checkliste mit Status je Punkt.' }
    ]
  },
  {
    id: 'GROWTH', title: 'Betrieb & Wachstum', weight: 10,
    goal: 'Kennzahlen, Feedback-Schleifen und kontinuierliche Verbesserung.',
    musts: [
      { key: 'kpi', role: 'GROWTH', title: 'KPI-Dashboard & Feedback-Loop', desc: 'Kennzahlen, Nutzerfeedback, Iterationsplan. Akzeptanz: KPI-Definition und Messplan.' },
      { key: 'kritik', role: 'CRITIC', title: 'Schwachstellen-Audit', desc: 'Risiken, Luecken, Verbesserungen. Akzeptanz: priorisierte Massnahmenliste.' }
    ]
  }
];

const norm = (s) => String(s || '').toLowerCase();

/** Passt eine bestehende Aufgabe auf eine Pflicht-Aufgabe? (Stichwort im Titel) */
function matches(task, must) {
  const t = norm(task.title);
  const k = norm(must.title).split(/[ &,\/\-]+/).filter((w) => w.length > 4);
  return k.some((w) => t.includes(w));
}

/**
 * Reifegrad einer Villa: je Phase der Anteil erledigter Pflicht-Aufgaben,
 * gewichtet zu einem Gesamtscore 0-100. Liefert auch die aktuelle Phase
 * (erste nicht vollstaendig erledigte).
 */
export function maturity(villaId) {
  const tasks = db.prepare('SELECT title, status FROM tasks WHERE villa_id = ?').all(villaId);
  const profile = deliveryProfile(villaId);
  const phasePlan = deliveryPhases(villaId) || PHASES;
  let score = 0;
  let current = null;
  const phases = phasePlan.map((ph) => {
    const items = ph.musts.map((m) => {
      const hit = tasks.filter((t) => matches(t, m));
      const done = hit.some((t) => t.status === 'DONE');
      const open = hit.some((t) => ['PENDING', 'READY', 'RUNNING', 'REVIEW'].includes(t.status));
      return { key: m.key, title: m.title, state: done ? 'DONE' : open ? 'OPEN' : 'MISSING' };
    });
    const doneN = items.filter((i) => i.state === 'DONE').length;
    const ratio = doneN / items.length;
    score += ph.weight * ratio;
    if (!current && ratio < 1) current = ph.id;
    return { id: ph.id, title: ph.title, goal: ph.goal, ratio: Number(ratio.toFixed(2)), items };
  });
  const planScore = Math.round(score);
  const readiness=deliveryReadiness(villaId);
  const passed=Object.values(readiness.checks).filter(c=>c.status==='passed').length;
  const ceiling=profile.id==='software'
    ? (!readiness.sourceFiles?25:readiness.verified?100:passed===2?90:passed===1?75:60)
    : (!readiness.artifacts?.length?25:readiness.verified?100:Math.min(75,45+passed*15));
  const unfinishedTasks=tasks.filter(t=>t.status!=='DONE' && t.status!=='CANCELLED').length;
  const s=Math.min(planScore,ceiling,unfinishedTasks?95:100);
  return {
    score: s,
    planScore, readiness, verified:readiness.verified && unfinishedTasks===0, unfinishedTasks, blockers:[...readiness.blockers,...(unfinishedTasks?[`${unfinishedTasks} Aufgaben noch nicht abgeschlossen`]:[])],
    stage: readiness.verified && s===100 ? 'Technisch verifiziert' : s >= 90 ? 'Abnahme offen' : s >= 65 ? 'Beta' : s >= 35 ? 'MVP in Arbeit' : 'Fruehphase',
    domain: profile.id, deliveryLabel: profile.label,
    currentPhase: current || phasePlan.at(-1).id,
    phases
  };
}

/**
 * Legt fehlende Pflicht-Aufgaben der AKTUELLEN Phase an (sowie der naechsten,
 * damit die Agenten nie leerlaufen). Rueckgabe: Anzahl neuer Aufgaben.
 */
export function ensurePhaseTasks(villaId) {
  const m = maturity(villaId);
  const phasePlan = deliveryPhases(villaId) || PHASES;
  const idx = Math.max(0, phasePlan.findIndex((p) => p.id === m.currentPhase));
  const tasks = db.prepare('SELECT title FROM tasks WHERE villa_id = ?').all(villaId);
  let added = 0;
  for (const ph of phasePlan.slice(idx, idx + 2)) {
    const state = m.phases.find((p) => p.id === ph.id);
    for (const must of ph.musts) {
      const item = state.items.find((i) => i.key === must.key);
      if (item.state !== 'MISSING') continue;
      if (tasks.some((t) => matches(t, must))) continue;
      const prio = 3 + phasePlan.indexOf(ph);
      db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(villaId, `[${ph.id}] ${must.title}`, `${must.desc}\nRolle: ${must.role}. Phase: ${ph.title}.`, 'PENDING', prio, now(), now());
      added++;
    }
  }
  return added;
}

/**
 * Rat → Aufgaben: aus den Vorschlaegen einer Rat-Runde entstehen echte
 * Aufgaben (max. 3 je Runde, dedupliziert gegen offene und juengste Aufgaben).
 */
export function proposalsToTasks(villaId, proposals) {
  const existing = db.prepare('SELECT title, description FROM tasks WHERE villa_id = ? ORDER BY id DESC LIMIT 200').all(villaId);
  let added = 0;
  for (const p of (proposals || []).slice(0, 3)) {
    const text = String(p.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 20) continue;
    const title = `[RAT] ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`;
    const key = norm(text).slice(0, 40);
    if (existing.some((t) => norm(t.title + t.description).includes(key))) continue;
    const description = `Ratsvorschlag von ${p.agent}: ${text}\nAkzeptanz: konkretes Artefakt (Datei, Bericht oder Code), das den Vorschlag umsetzt.`;
    db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(villaId, title, description, 'PENDING', 4, now(), now());
    existing.push({ title, description }); // auch innerhalb einer Runde nicht doppelt anlegen
    added++;
  }
  return added;
}

/**
 * Verbesserungswelle fuer reife Villen: sobald alle Pflichten erledigt sind,
 * kommen rotierend Wachstums-/Qualitaets-Aufgaben nach. So bleibt jede Villa
 * 24/7 in Bewegung, ohne dass derselbe Auftrag doppelt entsteht.
 */
/**
 * Mission-Modus (AUTONOMOUS MONETIZATION): Steht in der Villa-Idee der
 * Marker "AUTONOMOUS MONETIZATION", enthaelt JEDE Verbesserungswelle zwingend
 * eine direkt umsatzrelevante Codieraufgabe (MRR) mit Build-Verifikation.
 */
const REVENUE_TASK = {
  role: 'CODER',
  title: 'Umsatz-Feature der Welle umsetzen (MRR)',
  desc: 'Ein direkt geldrelevantes Feature im Projekt-Code implementieren (Stripe/Payment-Integration, Pricing-Tier, Paywall, Lead-Gen-Funnel, API-Abrechnung, Micro-SaaS-Feature). Keine Analyse-Texte: echter Code. Build & Tests lokal verifizieren (verify:esbuild, Regressionstests) und committen. Abschluss mit Wave-Output-Format: (1) Umsatz-Feature der Welle, (2) Build/Commit-Verifikation, (3) naechste Umsatz-Hypothese mit feingliedrigem Umsetzungsplan.'
};

const WAVES = [
  { role: 'GROWTH', title: 'Neue Akquise-Kanaele testen', desc: 'Drei neue Kanaele mit Hypothese, Aufwand und Messgroesse. Akzeptanz: Experiment-Plan mit Erfolgskriterium.' },
  { role: 'CRITIC', title: 'Konkurrenz-Update & Positionierung', desc: 'Neue Wettbewerber/Funktionen pruefen und Positionierung schaerfen. Akzeptanz: Delta-Bericht mit Handlungsempfehlungen.' },
  { role: 'CODER', title: 'Performance- und Kosten-Optimierung', desc: 'Engpaesse und Free-Tier-Kosten reduzieren. Akzeptanz: Messwerte vorher/nachher.' },
  { role: 'BUSINESS', title: 'Preis- und Umsatzoptimierung', desc: 'Preisstufen, Upsell, Bindung pruefen. Akzeptanz: Szenarien mit erwarteter Umsatzwirkung.' },
  { role: 'TESTER', title: 'Regression & Randfall-Erweiterung', desc: 'Neue Randfaelle aus Fehlerberichten testen. Akzeptanz: erweiterte Testfaelle.' },
  { role: 'DOCUMENTER', title: 'Doku & Wissensbasis aktualisieren', desc: 'Neue Funktionen, FAQ, Lernstand. Akzeptanz: aktualisierte Doku.' }
];

export function improvementWave(villaId) {
  const n = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND title LIKE '[WELLE%'").get(villaId).c;
  const villa = db.prepare('SELECT idea FROM villas WHERE id = ?').get(villaId);
  const monetization = /AUTONOMOUS MONETIZATION/i.test(String(villa?.idea || ''));
  let added = 0;
  for (let i = 0; i < 3; i++) {
    const w = WAVES[(n + i) % WAVES.length];
    const round = Math.floor((n + i) / WAVES.length) + 1;
    if (monetization && i === 0) {
      db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(villaId, `[WELLE ${round}] ${REVENUE_TASK.title}`, `${REVENUE_TASK.desc}\nRolle: ${REVENUE_TASK.role}.`, 'PENDING', 5, now(), now());
      added++;
    }
    db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(villaId, `[WELLE ${round}] ${w.title}`, `${w.desc}\nRolle: ${w.role}.`, 'PENDING', 6, now(), now());
    added++;
  }
  return added;
}

/**
 * Ein Zyklus der Dauerentwicklung fuer eine Villa. Reihenfolge:
 *   1. fehlende Phasen-Pflichten anlegen  2. falls nichts offen → Welle
 * Rueckgabe: { added, maturity }.
 */
export function developCycle(villaId) {
  let added = deliveryProfile(villaId).id === 'software' ? ensureVerificationTasks(villaId) : 0;
  added += ensurePhaseTasks(villaId);
  const open = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY','RUNNING','REVIEW')").get(villaId).c;
  if (open + added === 0) added += improvementWave(villaId);
  return { added, maturity: maturity(villaId) };
}
