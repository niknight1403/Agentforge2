/*
 * Innovations-Scout (v1.25): Die Villen analysieren ihre Projekte und schlagen
 * dem Besitzer deutlich begruendete bessere Alternativen vor - z. B. eine neue
 * App-Idee, die die eigene Idee uebertrifft. Ein Vorschlag bleibt 'pending',
 * bis der Besitzer ihn bestaetigt (dann gruendet der Hub selbststaendig eine
 * neue Villa mit Superagenten und passendem Masterprompt) oder ablehnt.
 * Zudem: explain() liefert eine klare WAS/WARUM/WIE-Erklaerung der aktuellen
 * Villa-Aktivitaet in normaler Sprache.
 */
import { db, now } from './db.mjs';
import { chat } from './llm.mjs';
import { maturity } from './product.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, proposed_name TEXT, why_better TEXT, benefits TEXT,
    masterprompt TEXT, agent_count INTEGER,
    status TEXT DEFAULT 'pending', villa_id INTEGER,
    created_at INTEGER, decided_at INTEGER
  )
`);

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function villaContext() {
  const villas = db.prepare('SELECT id, name, substr(idea, 1, 600) idea, status FROM villas ORDER BY id').all();
  return villas.map((v) => {
    const mt = maturity(v.id);
    return `- Villa ${v.id} "${v.name}" (Status ${v.status}, Reife ${mt.score}/100 - ${mt.stage}, Phase ${mt.currentPhase}): ${v.idea}`;
  }).join('\n') || '- (noch keine Villen)';
}

/** Erzeugt hoechstens einen neuen Vorschlag, wenn kein 'pending' existiert. */
export async function runScout({ force = false } = {}) {
  const pending = db.prepare("SELECT COUNT(*) c FROM proposals WHERE status = 'pending'").get().c;
  if (pending > 0 && !force) return { skipped: true, reason: 'Es wartet bereits ein Vorschlag auf die Entscheidung.' };

  const sys = [
    'Du bist der Innovations-Scout eines autonomen App-Entwicklungssystems (VillaForge).',
    'Analysiere die bestehenden Projekte (Villen) und schlage GENAU EINE deutlich bessere Alternative oder ein neues, ueberzeugendes Zusatzprojekt vor.',
    'Es darf auch eine neuartige App sein, die die Ideen der bestehenden Projekte klar uebertrifft.',
    'Antworte NUR mit JSON in exakt diesem Format:',
    '{"title": "kurzer Titel", "proposedName": "Projektname", "whyBetter": "deutlich erklaerte Begruendung in 4-6 Saetzen, warum sich das neue Projekt lohnt und inwiefern es die bisherigen Ideen uebertrifft", "benefits": ["Vorteil 1", "Vorteil 2", "Vorteil 3"], "masterprompt": "vollstaendiger Masterprompt (300-600 Zeichen) fuer die neue Villa: Ziel, Kernfunktionen, Tech-Stack, Phasen, Erfolgskriterien", "agentCount": 12}',
    'Alles auf Deutsch, konkret und ehrlich - keine Phrasen.'
  ].join('\n');

  const user = 'Bestehende Villen:\n' + villaContext() + '\n\nEntwickle daraus den besten neuen Projektvorschlag.';
  const res = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { role: 'BUSINESS', strategy: 'FALLBACK', maxTokens: 900 });
  const raw = res.answer || res.text || res.content || '';
  const p = parseJson(raw);
  if (!p || !p.title || !p.masterprompt) throw new Error('Scout-Antwort war kein gueltiges JSON: ' + String(raw).slice(0, 200));

  const info = db.prepare(
    `INSERT INTO proposals (title, proposed_name, why_better, benefits, masterprompt, agent_count, status, created_at)
     VALUES (?,?,?,?,?,?, 'pending', ?)`
  ).run(
    String(p.title).slice(0, 200),
    String(p.proposedName || p.title).slice(0, 120),
    String(p.whyBetter || '').slice(0, 4000),
    JSON.stringify((Array.isArray(p.benefits) ? p.benefits : []).slice(0, 6)),
    String(p.masterprompt).slice(0, 12000),
    Math.min(24, Math.max(8, Number(p.agentCount) || 12)),
    now()
  );
  return { created: true, id: Number(info.lastInsertRowid) };
}

export function listProposals({ status = '' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY id DESC LIMIT 20').all(status)
    : db.prepare("SELECT * FROM proposals WHERE status IN ('pending','approving','approved') ORDER BY id DESC LIMIT 20").all();
  return rows.map((r) => ({
    id: r.id, title: r.title, proposedName: r.proposed_name, whyBetter: r.why_better,
    benefits: JSON.parse(r.benefits || '[]'), masterprompt: r.masterprompt,
    agentCount: r.agent_count, status: r.status, villaId: r.villa_id, createdAt: r.created_at
  }));
}

/** Besitzer bestaetigt: Villa wird selbststaendig gegruendet und gestartet. */
export async function approveProposal(id, createVillaFn) {
  // Atomarer Claim: erst Status drehen, dann gruenden — verhindert doppelte
  // Villen, wenn der Besitzer mehrfach bestaetigt, waehrend createVilla laeuft.
  const claim = db.prepare("UPDATE proposals SET status = 'approving' WHERE id = ? AND status = 'pending'").run(Number(id));
  if (claim.changes === 0) throw new Error('Vorschlag nicht (mehr) offen.');
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(id));
  try {
    const villa = await createVillaFn({
      name: row.proposed_name || row.title,
      idea: row.masterprompt,
      agentCount: row.agent_count || 12,
      sourcePath: '',
      mode: 'BUILD'
    });
    db.prepare('UPDATE proposals SET status = ?, villa_id = ?, decided_at = ? WHERE id = ?')
      .run('approved', villa.id, now(), Number(id));
    return { villaId: villa.id, villaName: villa.name };
  } catch (err) {
    db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run('pending', Number(id));
    throw err;
  }
}

export function rejectProposal(id) {
  const info = db.prepare("UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(now(), Number(id));
  if (info.changes === 0) throw new Error('Vorschlag nicht (mehr) offen.');
  return { ok: true };
}

/** Klare Erklaerung der aktuellen Villa-Aktivitaet: WAS / WARUM / WIE. */
export async function explainVilla(villaId) {
  const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(Number(villaId));
  if (!villa) throw new Error('Villa nicht gefunden');
  const mt = maturity(villa.id);
  const tasks = db.prepare('SELECT title, status, substr(result, 1, 200) result FROM tasks WHERE villa_id = ? ORDER BY id DESC LIMIT 8').all(Number(villaId));
  const msgs = db.prepare(
    `SELECT a.name, a.role, m.role mrole, substr(m.content, 1, 300) content
     FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.villa_id = ? ORDER BY m.id DESC LIMIT 6`
  ).all(Number(villaId));

  const user = [
    `Villa "${villa.name}" (Status: ${villa.status}, Reife ${mt.score}/100 - ${mt.stage}, aktuelle Phase: ${mt.currentPhase})`,
    'Idee/Ziel: ' + String(villa.idea || '').slice(0, 800),
    'Letzte Aufgaben:',
    ...tasks.map((t) => `- [${t.status}] ${t.title}: ${t.result || 'laeuft/ohne Ergebnis'}`),
    'Letzte Agenten-Meldungen:',
    ...msgs.map((m) => `- ${m.name || 'Agent'} (${m.role || m.mrole}): ${m.content}`)
  ].join('\n');

  const sys = [
    'Du bist der Transparentmacher eines autonomen App-Entwicklungssystems.',
    'Erkläre dem Besitzer in normaler, freundlicher deutscher Sprache, was seine Villa gerade tut.',
    'Antworte NUR mit JSON: {"was": "was die Villa gerade konkret macht (2-4 Saetze)", "warum": "warum sie das macht - Ziel, Phase, Nutzen (2-4 Saetze)", "wie": "wie sie vorgeht - Agenten, Werkzeuge, naechste Schritte (2-4 Saetze)", "naechsterSchritt": "ein Satz zum naechsten Meilenstein"}'
  ].join('\n');

  const res = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { strategy: 'FALLBACK', timeoutMs: 90000, maxTokens: 700 });
  const raw = res.answer || res.text || res.content || '';
  const p = parseJson(raw);
  if (p && p.was) return { was: p.was, warum: p.warum, wie: p.wie, naechsterSchritt: p.naechsterSchritt || '' };
  return { was: String(raw).slice(0, 600), warum: '', wie: '', naechsterSchritt: '' };
}
