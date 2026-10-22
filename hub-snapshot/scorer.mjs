/**
 * SCORER (v1.45.0 — Nutzerdirektive 2026-10-22: "integriere einen Scorer").
 *
 * Bewertet abgeschlossene Aufgaben (DONE) heuristisch mit 0€ LLM-Kosten
 * (Local-First-Mandat: 80-90% Routinearbeit ohne Modellbelastung) und
 * aggregiert Villa-Produktivitaet. Die Werte speisen den Autopiloten und
 * die API (/api/scores). Optional kann spaeter eine LLM-Tiefenbewertung
 * hinter dem Setting 'scoreLLM' zugeschaltet werden — Standard: aus,
 * damit die Kaskaden-Kapazitaet den Villen-Agenten vorbehalten bleibt.
 *
 * Task-Score 0-100 (heuristisch, deterministisch, offline):
 *   40 Basis
 *   +10 Ergebnis-Substanz (>=200 Zeichen), +10 (>=800 Zeichen)
 *   +20 max. harte Erledigungs-Beweise (Tests, Build, README, Deploy, gruen)
 *   -30 max. Fehler-Marker im Ergebnis
 * Villa-Autopilot-Score 0-100:
 *   50% Durchschnitts-Task-Score, 25% Durchsatz (DONE/h, normiert),
 *   25% Stabilitaet (1 - Fehlerquote) abzueglich Busy-Churn.
 */
import { db, now } from './db.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS task_scores (
  task_id INTEGER PRIMARY KEY,
  villa_id INTEGER NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS villa_scores (
  villa_id INTEGER PRIMARY KEY,
  score INTEGER NOT NULL,
  breakdown TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_scores_villa ON task_scores (villa_id);
`);

const EVIDENCE = ['test', 'vitest', 'build', 'readme', 'deploy', 'installiert', 'erstellt', 'angepasst', 'gruen', 'passed', 'abgeschlossen', 'verifiziert', 'npm', 'git ', 'commit', 'migrat', 'api', 'route'];
const ERROR_MARK = ['fehler', 'error', 'failed', 'fehlgeschlagen', 'exception', 'abgebrochen', 'nicht erreichbar', 'unavailable', 'timeout'];

/** Heuristische Bewertung EINER abgeschlossenen Aufgabe (rein offline). */
export function scoreResult(resultText) {
  const t = String(resultText || '').toLowerCase();
  let score = 40;
  const reasons = [];
  if (t.length >= 200) { score += 10; reasons.push('Substanz'); }
  if (t.length >= 800) { score += 10; reasons.push('Tiefe'); }
  let evidence = 0;
  for (const e of EVIDENCE) if (t.includes(e)) evidence++;
  const evPoints = Math.min(20, evidence * 5);
  score += evPoints;
  if (evPoints) reasons.push(`${evidence} Beweis-Marker`);
  let errs = 0;
  for (const e of ERROR_MARK) if (t.includes(e)) errs++;
  const errPoints = Math.min(30, errs * 10);
  score -= errPoints;
  if (errs) reasons.push(`${errs} Fehler-Marker`);
  return { score: Math.max(0, Math.min(100, score)), reason: reasons.join(', ') || 'Basis' };
}

/** Bewertet bis `limit` unbewertete DONE-Aufgaben. Rueckgabe: Anzahl bewertet. */
export function scoreRecentTasks({ limit = 40 } = {}) {
  const rows = db.prepare(`
    SELECT t.id, t.villa_id, t.result FROM tasks t
    LEFT JOIN task_scores s ON s.task_id = t.id
    WHERE t.status = 'DONE' AND s.task_id IS NULL AND LENGTH(COALESCE(t.result,'')) > 0
    ORDER BY t.updated_at DESC LIMIT ?`).all(Number(limit) || 40);
  const ins = db.prepare('INSERT OR REPLACE INTO task_scores VALUES (?,?,?,?,?)');
  let scored = 0;
  for (const r of rows) {
    const { score, reason } = scoreResult(r.result);
    ins.run(r.id, r.villa_id, score, reason, now());
    scored++;
  }
  return scored;
}

/** Autopilot-Score je Villa: Substanz, Durchsatz, Stabilitaet, Busy-Churn. */
export function villaScores() {
  const rows = db.prepare(`
    SELECT v.id, v.name, v.status, v.autonomy,
           COALESCE((SELECT AVG(s.score) FROM task_scores s WHERE s.villa_id = v.id AND s.created_at > ? ), 0) AS avg_task,
           COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.villa_id = v.id AND t.status='DONE' AND t.updated_at > ? ), 0) AS done_hour,
           COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.villa_id = v.id), 0) AS total,
           COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.villa_id = v.id AND t.status='FAILED'), 0) AS failed,
           COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.villa_id = v.id AND t.status IN ('PENDING','READY','RUNNING')), 0) AS open
    FROM villas v WHERE v.status != 'ARCHIVED'`).all(now() - 24 * 3600_000, now() - 3600_000);
  const put = db.prepare('INSERT OR REPLACE INTO villa_scores VALUES (?,?,?,?)');
  const out = rows.map((r) => {
    const substance = (r.avg_task || 0) * 0.5;                      // 0-50
    const throughput = Math.min(25, (r.done_hour / 10) * 25);        // 10 DONE/h = voll
    const failRatio = r.total > 0 ? r.failed / r.total : 0;
    const stability = 25 * (1 - Math.min(1, failRatio));             // 0-25
    const busyChurn = db.prepare(`
      SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND updated_at > ? AND result LIKE 'LLM_UNAVAILABLE%'`)
      .get(r.id, now() - 30 * 60_000).c;
    const penalty = Math.min(15, busyChurn);                        // Busy-Stau kostet
    const score = Math.max(0, Math.round(substance + throughput + stability - penalty));
    const breakdown = {
      avgTaskScore: Math.round(r.avg_task || 0), doneLastHour: r.done_hour,
      failed: r.failed, total: r.total, open: r.open, busyChurn,
      substance: Math.round(substance), throughput: Math.round(throughput),
      stability: Math.round(stability), penalty,
    };
    put.run(r.id, score, JSON.stringify(breakdown), now());
    return { villaId: r.id, name: r.name, status: r.status, autonomy: r.autonomy,
             score, doneLastHour: r.done_hour, open: r.open, busyChurn,
             avgTaskScore: Math.round(r.avg_task || 0) };
  }).sort((a, b) => b.score - a.score);
  return out;
}

/** Snapshot fuer /api/scores. */
export function scoresSnapshot() {
  return {
    villas: villaScores(),
    scoredTasks: db.prepare('SELECT COUNT(*) c FROM task_scores').get().c,
    lastScores: db.prepare(`
      SELECT s.task_id, s.villa_id, t.title, s.score, s.reason FROM task_scores s
      LEFT JOIN tasks t ON t.id = s.task_id ORDER BY s.created_at DESC LIMIT 20`).all(),
  };
}
