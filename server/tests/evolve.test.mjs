// Test der Villa-Evolution gegen eine Wegwerf-Datenbank (LLM ersetzt).
// Start: node --test server/tests/evolve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-evolve-')), 'test.db');

process.chdir(mkdtempSync(join(tmpdir(), 'vf-cwd-')));
const { mkdirSync, writeFileSync } = await import('node:fs');
const { db, now } = await import('../db.mjs');
const { villaDir } = await import('../builds.mjs');
function giveWorkspace(v) { const d = villaDir(v); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'package.json'), '{"name":"x"}'); }
const evo = await import('../evolve.mjs');

const GOOD = JSON.stringify({
  title: 'Naechste Phase', summary: 'Weil der MVP steht.',
  items: [
    { title: 'Zahlungsfluss integrieren', description: 'Stripe-Checkout einbauen. Akzeptanz: Testzahlung laeuft.', role: 'CODER' },
    { title: 'Last- und Fehlertests', description: 'Randfaelle testen. Akzeptanz: 20 Testfaelle gruen.', role: 'TESTER' },
    { title: 'Zahlungsfluss integrieren', description: 'Doppelter Titel wird entfernt, Akzeptanz egal.', role: 'CODER' },
    { title: 'x', description: 'zu kurz', role: 'CODER' }
  ]
});
let calls = 0;
evo._setChat(async () => { calls++; return { answer: GOOD }; });

function villa(name) {
  const r = db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(name, 'Idee ' + name, 'RUNNING', now(), now());
  return Number(r.lastInsertRowid);
}
function task(v, title, status) {
  db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(v, title, 'd', status, 5, now(), now());
}

test('normalizeItems entfernt Doppelte und zu kurze Eintraege', () => {
  const out = evo.normalizeItems(JSON.parse(GOOD).items);
  assert.equal(out.length, 2);
  assert.deepEqual(evo.normalizeItems('kein array'), []);
});

test('keine Vorschlaege, solange Aufgaben offen sind oder nichts erledigt ist', async () => {
  const v = villa('offen'); task(v, 'Etwas offen', 'PENDING');
  assert.equal(evo.dueKind(evo.evolutionState(v)), null);
  const leer = villa('leer');
  assert.equal(evo.dueKind(evo.evolutionState(leer)), null);
});

test('erledigte Villa bekommt NEXT_PHASES; Bestaetigung legt echte Aufgaben an', async () => {
  const v = villa('fertig'); task(v, 'Alles erledigt', 'DONE');
  assert.equal(evo.dueKind(evo.evolutionState(v)), 'NEXT_PHASES');
  const r = await evo.proposeForVilla(v, 'NEXT_PHASES');
  assert.equal(r.created, true); assert.equal(r.items, 2);
  // Zweiter Aufruf: kein zweiter offener Vorschlag derselben Art.
  assert.equal((await evo.proposeForVilla(v, 'NEXT_PHASES')).skipped, true);
  const ap = evo.approveVillaProposal(r.id);
  assert.equal(ap.added, 2);
  const titles = db.prepare("SELECT title FROM tasks WHERE villa_id = ? AND status = 'PENDING'").all(v).map((t) => t.title);
  assert.ok(titles.some((t) => t.startsWith('[PHASE 1] Zahlungsfluss')));
  // Doppelt bestaetigen scheitert (atomarer Claim).
  assert.throws(() => evo.approveVillaProposal(r.id), /nicht \(mehr\) offen/);
});

test('Ablehnen legt keine Aufgaben an', async () => {
  const v = villa('ablehnen'); task(v, 'Erledigt', 'DONE');
  const r = await evo.proposeForVilla(v, 'NEXT_PHASES');
  evo.rejectVillaProposal(r.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status = 'PENDING'").get(v).c, 0);
  assert.equal(evo.listVillaProposals(v).length, 0);
});

test('nach MAX_PHASE_ROUNDS bestaetigten Runden und vollen Phasen wird PERFECT faellig', async () => {
  const v = villa('perfekt');
  // Alle Pflicht-Aufgaben der 6 Phasen als erledigt anlegen (Stichworte wie product.mjs).
  for (const t of ['Marktanalyse & Wettbewerber', 'Zielgruppen- und Preismodell', 'MVP-Umfang & Roadmap', 'Architektur & Datenmodell',
    'MVP-Kernfunktionen implementieren', 'Code-Review & Sicherheitspruefung', 'Testsuite & Randfaelle', 'Dokumentation & Onboarding',
    'Go-to-Market & Launch-Plan', 'Rechtliches & Compliance', 'KPI-Dashboard & Feedback-Loop', 'Schwachstellen-Audit']) task(v, t, 'DONE');
  for (let i = 0; i < evo.MAX_PHASE_ROUNDS; i++) {
    db.prepare("INSERT INTO villa_proposals (villa_id, kind, title, status, round, created_at) VALUES (?,?,?,?,?,?)").run(v, 'NEXT_PHASES', 't', 'approved', i + 1, now());
  }
  giveWorkspace(v);
  const {verifyProjectRuntime}=await import('../project-verification.mjs');
  const d=villaDir(v);
  writeFileSync(join(d,'index.mjs'),'export const app=true;');
  writeFileSync(join(d,'package.json'),JSON.stringify({scripts:{build:'node check.mjs',test:'node check.mjs',smoke:'node check.mjs'}}));
  await verifyProjectRuntime(v,{runner:async()=>({ok:true})});
  const st = evo.evolutionState(v);
  assert.equal(st.phasesComplete, true);
  assert.equal(st.stage, 'PERFECTING');
  assert.equal(evo.dueKind(st), 'PERFECT');
  const r = await evo.proposeForVilla(v, 'PERFECT');
  assert.equal(evo.approveVillaProposal(r.id).added, 2);
  assert.ok(db.prepare("SELECT title FROM tasks WHERE villa_id = ? AND title LIKE '[PERFEKT]%'").all(v).length === 2);
});

test('evolveAll respektiert das Limit pro Takt und meldet Fehler statt zu werfen', async () => {
  for (let i = 0; i < 4; i++) { const v = villa('batch' + i); task(v, 'Erledigt', 'DONE'); }
  const made = await evo.evolveAll({ maxPerTick: 2 });
  assert.ok(made.filter((m) => m.created).length <= 2);
  evo._setChat(async () => { throw new Error('Netz weg'); });
  const v = villa('kaputt'); task(v, 'Erledigt', 'DONE');
  const res = await evo.evolveAll({ maxPerTick: 50 });
  assert.ok(res.some((m) => m.villaId === v && m.error), 'harter Fehler wird gemeldet statt zu werfen');
  evo._setChat(async () => ({ answer: GOOD }));
});

test('Marketplace-Vorschlag kommt erst nach mind. einer bestaetigten Phasen-Runde', async () => {
  evo._setChat(async () => ({ answer: GOOD }));
  const v = villa('markt'); task(v, 'Erledigt', 'DONE');
  assert.equal(evo.evolutionState(v).rounds, 0);
  const r = await evo.proposeForVilla(v, 'NEXT_PHASES'); evo.approveVillaProposal(r.id);
  db.prepare("UPDATE tasks SET status = 'DONE' WHERE villa_id = ?").run(v);
  await evo.evolveAll({ maxPerTick: 100 });
  const kinds = evo.listVillaProposals(v, { status: 'pending' }).map((p) => p.kind);
  assert.ok(kinds.includes('MARKETPLACE'));
});

test('leerer Workspace: Phasen 100 %, aber NICHT fertig - Perfektion bleibt gesperrt, Code-Aufgaben werden verlangt', async () => {
  const v = villa('leer-aber-100');
  for (const t of ['Marktanalyse & Wettbewerber', 'Zielgruppen- und Preismodell', 'MVP-Umfang & Roadmap', 'Architektur & Datenmodell',
    'MVP-Kernfunktionen implementieren', 'Code-Review & Sicherheitspruefung', 'Testsuite & Randfaelle', 'Dokumentation & Onboarding',
    'Go-to-Market & Launch-Plan', 'Rechtliches & Compliance', 'KPI-Dashboard & Feedback-Loop', 'Schwachstellen-Audit']) task(v, t, 'DONE');
  for (let i = 0; i < evo.MAX_PHASE_ROUNDS; i++) {
    db.prepare("INSERT INTO villa_proposals (villa_id, kind, title, status, round, created_at) VALUES (?,?,?,?,?,?)").run(v, 'NEXT_PHASES', 't', 'approved', i + 1, now());
  }
  const st = evo.evolutionState(v);
  assert.equal(st.phasesComplete, true);
  assert.equal(st.workspaceEmpty, true);
  assert.equal(st.developmentComplete, false);       // Screenshot-Fall: 100 %, aber nichts gebaut
  assert.equal(evo.dueKind(st), 'NEXT_PHASES');      // nicht PERFECT
  let seen = '';
  evo._setChat(async (msgs) => { seen = msgs[0].content; return { answer: GOOD }; });
  await evo.proposeForVilla(v, 'NEXT_PHASES');
  assert.match(seen, /Projektordner der Villa ist LEER/);
  evo._setChat(async () => ({ answer: GOOD }));
});

test('mit Dateien im Workspace entfaellt der Leer-Hinweis', async () => {
  const v = villa('mit-dateien'); task(v, 'Erledigt', 'DONE'); giveWorkspace(v);
  assert.equal(evo.evolutionState(v).workspaceEmpty, false);
  let seen = '';
  evo._setChat(async (msgs) => { seen = msgs[0].content; return { answer: GOOD }; });
  await evo.proposeForVilla(v, 'NEXT_PHASES');
  assert.doesNotMatch(seen, /LEER/);
});

test('Offline-Planer: kein Stillstand - Standardplan als ehrlich gekennzeichneter Vorschlag', async () => {
  const v = villa('offline'); task(v, 'Erledigt', 'DONE');
  evo._setChat(async () => ({ offline: true, answer: '## Zusammenfassung\n\nDeine Nachricht ... kein JSON' }));
  const r = await evo.proposeForVilla(v, 'NEXT_PHASES');
  assert.equal(r.created, true);
  assert.equal(r.fallback, true);
  const prop = evo.listVillaProposals(v, { status: 'pending' })[0];
  assert.match(prop.summary, /Kein Sprachmodell erreichbar/);
  assert.ok(prop.items.some((i) => /Projektgeruest/.test(i.title)), 'leerer Workspace verlangt Geruest-Aufgabe');
  assert.equal(evo.approveVillaProposal(r.id).added, prop.items.length);
  evo._setChat(async () => ({ answer: GOOD }));
});

test('Unbrauchbare Modellantwort (kein JSON) faellt ebenfalls auf den Standardplan zurueck', async () => {
  const v = villa('muell'); task(v, 'Erledigt', 'DONE'); giveWorkspace(v);
  evo._setChat(async () => ({ answer: 'Hier ist kein JSON' }));
  const r = await evo.proposeForVilla(v, 'PERFECT');
  assert.equal(r.fallback, true);
  const prop = evo.listVillaProposals(v, { status: 'pending' })[0];
  assert.ok(!prop.items.some((i) => /Projektgeruest/.test(i.title)), 'mit Dateien keine Geruest-Aufgabe');
  evo._setChat(async () => ({ answer: GOOD }));
});

test('Gutes Modell-JSON wird NICHT durch den Standardplan ersetzt', async () => {
  const v = villa('gut'); task(v, 'Erledigt', 'DONE');
  const r = await evo.proposeForVilla(v, 'NEXT_PHASES');
  assert.equal(r.fallback, false);
});

test('REVENUE-Vorschlag schreibt die Endprodukt-Vision auf die Villa', async () => {
  evo._setChat(async () => ({ content: JSON.stringify({
    endProduct: 'Verkaufsfertige Android-App als Abo mit Zahlungsanbindung, 9,90 EUR/Monat.',
    title: 'Weg zum Umsatz',
    summary: 'Zielkunden: Selbststaendige. Preis: 9,90 EUR/Monat. Partner: App-Store, Tech-Blogs.',
    items: [
      { title: 'Landingpage mit Preis', description: 'Akzeptanz: Seite im Browser mit Preis.', role: 'CODER' },
      { title: 'Zahlungslink testen', description: 'Akzeptanz: Link klickbar.', role: 'BUSINESS' }
    ]
  }) }));
  const ids = db.prepare('SELECT id FROM villas ORDER BY id LIMIT 1').all();
  const r = await evo.proposeForVilla(ids[0].id, 'REVENUE');
  assert.equal(r.created, true);
  const v = db.prepare('SELECT vision FROM villas WHERE id = ?').get(ids[0].id);
  assert.ok(String(v.vision).includes('9,90 EUR'), 'Vision muss das Endprodukt mit Preis enthalten: ' + v.vision);
});
