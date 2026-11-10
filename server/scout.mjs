/*
 * Innovations-Scout (v1.25): Die Villen analysieren ihre Projekte und schlagen
 * dem Besitzer deutlich begruendete bessere Alternativen vor - z. B. eine neue
 * App-Idee, die die eigene Idee uebertrifft. Ein Vorschlag bleibt 'pending',
 * bis der Besitzer ihn bestaetigt (dann gruendet der Hub selbststaendig eine
 * neue Villa mit Superagenten und passendem Masterprompt) oder ablehnt.
 * Zudem: explain() liefert eine klare WAS/WARUM/WIE-Erklaerung der aktuellen
 * Villa-Aktivitaet in normaler Sprache.
 *
 * Issue #130 (2026-11-10): Jeder Vorschlag traegt vor der Freigabe eine
 * Projektart (NEW_PROJECT, INTEGRATION, SUBPROJECT) und - bei Integration in
 * ein bestehendes Projekt - ein belegtes Ziel (owner/name, Branch, Unterpfad).
 * Ohne Projektart und Zielzuordnung ist keine Freigabe moeglich; mehrdeutige
 * Zuordnungen blockieren den Vorschlag, bis der Besitzer ihn klaert.
 */
import { db, now } from './db.mjs';
import { chat } from './llm.mjs';
import { maturity } from './product.mjs';
import {
  bindVillaRepo,
  normalizeBranch,
  normalizeRepo,
  normalizeTargetPath,
  villaRepoMap
} from './repo-target.mjs';

db.exec(`
  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, proposed_name TEXT, why_better TEXT, benefits TEXT,
    masterprompt TEXT, agent_count INTEGER,
    status TEXT DEFAULT 'pending', villa_id INTEGER,
    created_at INTEGER, decided_at INTEGER
  )
`);

/** Projektarten einer Freigabe (Issue #130). */
export const PROJECT_TYPES = Object.freeze(['NEW_PROJECT', 'INTEGRATION', 'SUBPROJECT']);

/** Nachtraegliche Spalten fuer bestehende Datenbanken (idempotent). */
function ensureProposalColumn(column, definition) {
  const columns = db.prepare('PRAGMA table_info(proposals)').all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE proposals ADD COLUMN ${column} ${definition}`);
}
ensureProposalColumn('project_type', "TEXT NOT NULL DEFAULT ''");
ensureProposalColumn('target_repo', "TEXT NOT NULL DEFAULT ''");
ensureProposalColumn('target_branch', "TEXT NOT NULL DEFAULT ''");
ensureProposalColumn('target_path', "TEXT NOT NULL DEFAULT ''");
ensureProposalColumn('classification_reason', "TEXT NOT NULL DEFAULT ''");
ensureProposalColumn('confidence', 'REAL NOT NULL DEFAULT 0');
ensureProposalColumn('blocked_reason', "TEXT NOT NULL DEFAULT ''");

/*
 * Altbestand: Vorschlaege aus der Zeit vor der Projektart wurden ausnahmslos als
 * eigenstaendige Villa gegruendet (sourcePath '', mode BUILD). Sie werden
 * einmalig und nachvollziehbar als NEW_PROJECT uebernommen, damit kein alter
 * offener Vorschlag stillschweigend blockiert - neue Vorschlaege muessen ihre
 * Projektart dagegen selbst mitbringen.
 */
db.prepare(
  `UPDATE proposals
      SET project_type = 'NEW_PROJECT',
          classification_reason = 'Migration 2026-11-10: vor Einfuehrung der Projektart als eigenstaendiges Projekt uebernommen',
          confidence = 0.5
    WHERE (project_type IS NULL OR project_type = '') AND status IN ('pending', 'approving')`
).run();

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

/** Belegte Zielrepositorys: nur diese duerfen als INTEGRATION gelten. */
function repoContext(map = villaRepoMap()) {
  const lines = [];
  for (const [repo, villas] of map) {
    lines.push(`- ${repo}${villas[0].branch ? ` (Branch ${villas[0].branch})` : ''} -> Villa ${villas.map((v) => `#${v.id} "${v.name}"`).join(', ')}`);
  }
  return lines.join('\n') || '- (noch keine Villa ist mit einem Repository verbunden)';
}

const TYPE_ALIASES = {
  NEW: 'NEW_PROJECT', NEWPROJECT: 'NEW_PROJECT', NEW_PROJECT: 'NEW_PROJECT', GREENFIELD: 'NEW_PROJECT',
  INTEGRATION: 'INTEGRATION', INTEGRATE: 'INTEGRATION', EXTENSION: 'INTEGRATION', ERWEITERUNG: 'INTEGRATION',
  SUBPROJECT: 'SUBPROJECT', SUB_PROJECT: 'SUBPROJECT', TEILPROJEKT: 'SUBPROJECT'
};

/**
 * Bringt die Modellantwort auf den Freigabe-Vertrag. Reine Funktion: sie
 * schreibt nichts und liefert nur die normalisierte Klassifikation samt
 * Begruendung fuer blockierte Faelle.
 */
export function classifyProposal(raw = {}) {
  const blockers = [];
  const rawType = String(raw.projectType ?? raw.project_type ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const projectType = TYPE_ALIASES[rawType] || '';
  const classificationReason = String(raw.classificationReason ?? raw.classification_reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;

  if (!projectType) blockers.push('Projektart fehlt oder ist unbekannt (erlaubt: NEW_PROJECT, INTEGRATION, SUBPROJECT).');
  if (classificationReason.length < 10) blockers.push('Begruendung der Projektart fehlt.');

  let targetRepo = normalizeRepo(raw.targetRepo ?? raw.target_repo);
  let targetBranch = normalizeBranch(raw.targetBranch ?? raw.target_branch);
  let targetPath = '';
  try {
    targetPath = normalizeTargetPath(raw.targetPath ?? raw.target_path);
  } catch (err) {
    blockers.push(String(err.message || err));
  }

  if (projectType === 'NEW_PROJECT') {
    // Ein eigenstaendiges Projekt hat kein Zielrepository. Falls das Modell
    // trotzdem eines nennt, wird es nicht uebernommen (keine stillen Bindungen).
    targetRepo = '';
    targetBranch = '';
    targetPath = '';
  } else if (projectType) {
    if (!targetRepo) blockers.push('Zielrepository fehlt oder ist ungueltig (erwartet owner/name).');
    if (projectType === 'SUBPROJECT' && !targetPath) blockers.push('Zielpfad im Monorepo fehlt.');
  }

  return { projectType, targetRepo, targetBranch, targetPath, classificationReason, confidence, blockers };
}

/**
 * Entscheidet, was eine Freigabe ausloest - ohne Nebenwirkungen.
 * Aktionen: create_new_project | integrate | create_integration_villa | blocked
 */
export function approvalPlan(row = {}, { map = villaRepoMap() } = {}) {
  const classification = classifyProposal(row);
  const blockers = [...classification.blockers];
  const base = { classification, projectType: classification.projectType };

  if (classification.projectType === 'NEW_PROJECT') {
    return { ...base, action: blockers.length ? 'blocked' : 'create_new_project', blockers };
  }
  if (!classification.projectType) return { ...base, action: 'blocked', blockers };

  const bound = classification.targetRepo ? (map.get(classification.targetRepo) || []) : [];
  let branch = classification.targetBranch;
  if (!branch && bound.length === 1) branch = bound[0].branch || '';
  if (classification.targetRepo && !branch) blockers.push('Zielbranch fehlt und ist aus keiner Villa belegbar.');

  if (bound.length > 1) {
    blockers.push(`Mehrdeutig: ${classification.targetRepo} ist mit mehreren Villen verbunden (${bound.map((v) => `#${v.id} "${v.name}"`).join(', ')}). Klaerung noetig.`);
  }
  if (blockers.length) {
    return { ...base, action: 'blocked', blockers, repo: classification.targetRepo, branch, path: classification.targetPath };
  }
  if (bound.length === 1) {
    return { ...base, action: 'integrate', blockers, villaId: bound[0].id, repo: classification.targetRepo, branch, path: classification.targetPath };
  }
  return { ...base, action: 'create_integration_villa', blockers, repo: classification.targetRepo, branch, path: classification.targetPath };
}

/** Erzeugt hoechstens einen neuen Vorschlag, wenn kein 'pending' existiert. */
export async function runScout({ force = false } = {}) {
  const pending = db.prepare("SELECT COUNT(*) c FROM proposals WHERE status = 'pending'").get().c;
  if (pending > 0 && !force) return { skipped: true, reason: 'Es wartet bereits ein Vorschlag auf die Entscheidung.' };

  const sys = [
    'Du bist der Innovations-Scout eines autonomen App-Entwicklungssystems (VillaForge).',
    'Analysiere die bestehenden Projekte (Villen) und schlage GENAU EINE deutlich bessere Alternative oder ein sinnvolles Zusatzprojekt vor.',
    'Es darf auch eine neuartige App sein, die die Ideen der bestehenden Projekte klar uebertrifft.',
    'Ordne den Vorschlag einer Projektart zu:',
    '- NEW_PROJECT: eigenstaendiges neues Produkt mit eigenem Workspace.',
    '- INTEGRATION: Erweiterung eines BESTEHENDEN Projekts; Zielrepository, Branch und Begruendung sind Pflicht.',
    '- SUBPROJECT: eigenstaendiges Teilprojekt, das in ein bestehendes Monorepo eingeordnet wird; zusaetzlich ist der Zielpfad Pflicht.',
    'Fuer INTEGRATION und SUBPROJECT darfst du NUR ein Repository aus der Liste "Belegte Zielrepositorys" verwenden - erfinde niemals ein Repository und schliesse nie aus einem aehnlichen Namen auf ein Ziel.',
    'Wenn keine Zuordnung sicher ist, waehle NEW_PROJECT und erklaere das in classificationReason.',
    'Antworte NUR mit JSON in exakt diesem Format:',
    '{"title": "kurzer Titel", "proposedName": "Projektname", "projectType": "NEW_PROJECT|INTEGRATION|SUBPROJECT", "targetRepo": "owner/name oder null", "targetBranch": "Branch oder null", "targetPath": "Unterpfad im Monorepo oder null", "classificationReason": "2-4 Saetze, warum genau diese Projektart und dieses Ziel", "confidence": 0.0, "whyBetter": "deutlich erklaerte Begruendung in 4-6 Saetzen, warum sich das Projekt lohnt und inwiefern es die bisherigen Ideen uebertrifft", "benefits": ["Vorteil 1", "Vorteil 2", "Vorteil 3"], "masterprompt": "vollstaendiger Masterprompt (300-600 Zeichen) fuer die neue Villa oder Integration: Ziel, Kernfunktionen, Tech-Stack, Phasen, Erfolgskriterien", "agentCount": 12}',
    '"confidence" ist eine Zahl zwischen 0 und 1 fuer die Sicherheit der Projektart und der Zielzuordnung.',
    'Alles auf Deutsch, konkret und ehrlich - keine Phrasen.'
  ].join('\n');

  const user = [
    'Bestehende Villen:',
    villaContext(),
    '',
    'Belegte Zielrepositorys:',
    repoContext(),
    '',
    'Entwickle daraus den besten Projektvorschlag.'
  ].join('\n');

  const res = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { role: 'BUSINESS', strategy: 'FALLBACK', maxTokens: 1000 });
  const raw = res.answer || res.text || res.content || '';
  const p = parseJson(raw);
  if (!p || !p.title || !p.masterprompt) throw new Error('Scout-Antwort war kein gueltiges JSON: ' + String(raw).slice(0, 200));

  const classification = classifyProposal(p);
  const info = db.prepare(
    `INSERT INTO proposals (title, proposed_name, why_better, benefits, masterprompt, agent_count, status, created_at,
                            project_type, target_repo, target_branch, target_path, classification_reason, confidence, blocked_reason)
     VALUES (?,?,?,?,?,?, 'pending', ?, ?,?,?,?,?,?,?)`
  ).run(
    String(p.title).slice(0, 200),
    String(p.proposedName || p.title).slice(0, 120),
    String(p.whyBetter || '').slice(0, 4000),
    JSON.stringify((Array.isArray(p.benefits) ? p.benefits : []).slice(0, 6)),
    String(p.masterprompt).slice(0, 12000),
    Math.min(24, Math.max(8, Number(p.agentCount) || 12)),
    now(),
    classification.projectType,
    classification.targetRepo,
    classification.targetBranch,
    classification.targetPath,
    classification.classificationReason,
    classification.confidence,
    classification.blockers.join(' | ')
  );
  return { created: true, id: Number(info.lastInsertRowid), projectType: classification.projectType || null };
}

function proposalView(r) {
  return {
    id: r.id, title: r.title, proposedName: r.proposed_name, whyBetter: r.why_better,
    benefits: JSON.parse(r.benefits || '[]'), masterprompt: r.masterprompt,
    agentCount: r.agent_count, status: r.status, villaId: r.villa_id, createdAt: r.created_at,
    projectType: r.project_type || '', targetRepo: r.target_repo || '', targetBranch: r.target_branch || '',
    targetPath: r.target_path || '', classificationReason: r.classification_reason || '',
    confidence: Number(r.confidence) || 0, blockedReason: r.blocked_reason || ''
  };
}

export function listProposals({ status = '' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY id DESC LIMIT 20').all(status)
    : db.prepare("SELECT * FROM proposals WHERE status IN ('pending','approving','approved') ORDER BY id DESC LIMIT 20").all();
  return rows.map(proposalView);
}

/**
 * Besitzer korrigiert die Projektart bzw. das Ziel und loest damit eine
 * Blockade auf. Nur offene Vorschlaege sind klaerbar.
 */
export function clarifyProposal(id, patch = {}) {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('Vorschlag nicht gefunden'), { statusCode: 404 });
  if (!['pending', 'approving'].includes(row.status)) {
    throw Object.assign(new Error('Nur offene Vorschlaege koennen geklaert werden.'), { statusCode: 409 });
  }
  const merged = {
    ...row,
    projectType: patch.projectType ?? row.project_type,
    targetRepo: patch.targetRepo ?? row.target_repo,
    targetBranch: patch.targetBranch ?? row.target_branch,
    targetPath: patch.targetPath ?? row.target_path,
    classificationReason: patch.classificationReason ?? row.classification_reason
  };
  const classification = classifyProposal(merged);
  if (!classification.projectType) {
    throw Object.assign(new Error(classification.blockers.join(' ')), { statusCode: 400 });
  }
  db.prepare(
    `UPDATE proposals SET project_type = ?, target_repo = ?, target_branch = ?, target_path = ?,
       classification_reason = ?, confidence = ?, blocked_reason = '' WHERE id = ?`
  ).run(
    classification.projectType,
    classification.targetRepo,
    classification.targetBranch,
    classification.targetPath,
    classification.classificationReason,
    Number(patch.confidence ?? row.confidence) || classification.confidence,
    Number(id)
  );
  return { ok: true, proposal: proposalView(db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(id))) };
}

/** Bindung + Integrationsauftrag in einer bestehenden Villa (Standardweg). */
function integrateIntoVilla(row, plan) {
  const binding = bindVillaRepo(plan.villaId, { repo: plan.repo, branch: plan.branch, path: plan.path });
  const villa = db.prepare('SELECT id, name FROM villas WHERE id = ?').get(plan.villaId);
  if (!villa) throw new Error(`Villa #${plan.villaId} fuer die Integration nicht gefunden.`);
  const title = `[INTEGRATION] ${String(row.proposed_name || row.title || 'Erweiterung').slice(0, 80)}`;
  const description = [
    `Erweiterung des bestehenden Projekts ${plan.repo}${plan.branch ? ` (Branch ${plan.branch})` : ''}${plan.path ? `, Pfad ${plan.path}` : ''}.`,
    String(row.masterprompt || '').slice(0, 4000),
    `Projektart: ${plan.projectType} - ${String(row.classification_reason || '').slice(0, 400)}`,
    'Akzeptanz: Änderungen nur auf einem Feature-Branch, Tests/Build grün, danach Pull Request gegen den Zielbranch. Keine Commits auf den Default-Branch.'
  ].filter(Boolean).join('\n');
  const existing = db.prepare('SELECT id FROM tasks WHERE villa_id = ? AND title = ?').get(villa.id, title);
  const taskId = existing?.id || Number(db.prepare(
    "INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,'PENDING',3,?,?)"
  ).run(villa.id, title, description, now(), now()).lastInsertRowid);
  return { villaId: villa.id, villaName: villa.name, taskId, repo: binding.repo, branch: binding.branch, path: binding.path };
}

/**
 * Besitzer bestaetigt: je nach Projektart wird eine eigenstaendige Villa
 * gegruendet oder die vorhandene, repository-gebundene Villa erweitert.
 */
export async function approveProposal(id, createVillaFn, options = {}) {
  const { integrateFn = integrateIntoVilla, map = villaRepoMap(), bindFn = bindVillaRepo } = options;
  // Atomarer Claim: erst Status drehen, dann gruenden — verhindert doppelte
  // Villen, wenn der Besitzer mehrfach bestaetigt, waehrend createVilla laeuft.
  const claim = db.prepare("UPDATE proposals SET status = 'approving' WHERE id = ? AND status = 'pending'").run(Number(id));
  if (claim.changes === 0) throw new Error('Vorschlag nicht (mehr) offen.');
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(id));
  const plan = approvalPlan(row, { map });

  if (plan.action === 'blocked') {
    db.prepare("UPDATE proposals SET status = 'pending', blocked_reason = ? WHERE id = ?")
      .run(plan.blockers.join(' | ').slice(0, 1000), Number(id));
    throw Object.assign(new Error('Vorschlag blockiert: ' + plan.blockers.join(' ')), {
      code: 'PROPOSAL_BLOCKED', statusCode: 409, blockers: plan.blockers
    });
  }

  try {
    if (plan.action === 'integrate') {
      const result = await integrateFn(row, plan);
      const createdId = Number(result?.villaId ?? result?.id);
      if (!Number.isSafeInteger(createdId) || createdId < 1) throw new Error('Integration lieferte keine gueltige Villa-ID.');
      db.prepare("UPDATE proposals SET status = 'approved', villa_id = ?, decided_at = ?, blocked_reason = '' WHERE id = ?")
        .run(createdId, now(), Number(id));
      return {
        villaId: createdId,
        villaName: result.villaName || '',
        projectType: plan.projectType,
        integrated: true,
        taskId: result.taskId || null,
        repo: plan.repo,
        branch: result.branch ?? plan.branch,
        path: result.path ?? plan.path
      };
    }

    const integration = plan.action === 'create_integration_villa';
    const villa = await createVillaFn({
      name: row.proposed_name || row.title,
      idea: row.masterprompt,
      agentCount: row.agent_count || 12,
      sourcePath: '',
      mode: integration ? 'INTEGRATION' : 'BUILD'
    });
    const createdId = Number(villa?.villaId ?? villa?.id);
    if (!Number.isSafeInteger(createdId) || createdId < 1) throw new Error('Villa-Erstellung lieferte keine gueltige Villa-ID.');
    if (integration) bindFn(createdId, { repo: plan.repo, branch: plan.branch, path: plan.path });
    db.prepare("UPDATE proposals SET status = ?, villa_id = ?, decided_at = ?, blocked_reason = '' WHERE id = ?")
      .run('approved', createdId, now(), Number(id));
    if (!integration) return { villaId: createdId, villaName: villa.name || row.proposed_name || row.title };
    return {
      villaId: createdId,
      villaName: villa.name || row.proposed_name || row.title,
      projectType: plan.projectType,
      integrated: false,
      repo: plan.repo,
      branch: plan.branch,
      path: plan.path
    };
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
