/**
 * Dead-Letter-Queue + Alerting-Agent fuer den Agenten-Event-Bus.
 *
 * Aufgabe: Gescheiterte Agenten-Workflows (Tasks, die das Retry-Limit erreicht
 * haben, sowie `agent.failed`-Events vom Redis-Stream-Bus) werden isoliert,
 * protokolliert und kontrolliert neu eingereiht. Nach MAX_ATTEMPTS wird
 * eskaliert (Alert), statt endlos zu wiederholen.
 *
 * Design-Regeln:
 *  - Nie werfen: Der DLQ-Pfad darf den Hub-Betrieb nicht stoeren (try/catch an
 *    allen Aufrufstellen, Rueckgabe von Statusobjekten statt Exceptions).
 *  - Keine neuen Abhaengigkeiten (nur node:sqlite ueber db.mjs + redis.mjs).
 *  - Isolation heisst: Der Task wird NICHT geloescht, sondern aus dem normalen
 *    Loop genommen (FAILED bleibt FAILED) und der DLQ-Eintrag fuehrt Buch.
 *  - Requeue setzt den Task auf PENDING mit retry_count+1 (gleiches Muster wie
 *    requeueFailed in agents.mjs), damit der Scheduler ihn wieder aufnimmt.
 */
import { db } from './db.mjs';
import { redisTryStreamAdd } from './redis.mjs';

export const DLQ_STREAM = process.env.VF_EVENT_DLQ_STREAM || 'vf:agent-events:dlq';
export const MAX_ATTEMPTS = Number(process.env.VF_DLQ_MAX_ATTEMPTS || 3);
const OPEN_STATES = ['OPEN', 'ESCALATED'];

let initialized = false;

export function initDlq() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_dlq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL DEFAULT '',
      villa_id INTEGER,
      task_id INTEGER,
      agent_id INTEGER,
      code TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'OPEN',
      attempts INTEGER NOT NULL DEFAULT 0,
      stream_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dlq_status ON event_dlq(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dlq_task ON event_dlq(task_id, code);
    CREATE TABLE IF NOT EXISTS event_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dlq_id INTEGER NOT NULL,
      villa_id INTEGER,
      severity TEXT NOT NULL DEFAULT 'warn',
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
  `);
  initialized = true;
}

function ensure() { if (!initialized) initDlq(); }

/** Villa eines Tasks ermitteln (fuer Events, die keine villaId tragen). */
function villaOfTask(taskId) {
  if (!taskId) return null;
  const row = db.prepare('SELECT villa_id FROM tasks WHERE id = ?').get(Number(taskId));
  return row ? Number(row.villa_id) : null;
}

/**
 * Isoliert einen gescheiterten Workflow: legt genau einen offenen DLQ-Eintrag
 * je (taskId, code) an und erhoeht bei Wiederholung nur den Zaehler.
 * @returns {{ok: boolean, id?: number, duplicate?: boolean, error?: string}}
 */
export function isolateFailedWorkflow({ eventId = '', villaId = null, taskId = null, agentId = null, code = '', message = '' } = {}) {
  ensure();
  try {
    const t = Date.now();
    const vid = villaId != null ? Number(villaId) : villaOfTask(taskId);
    const tid = taskId != null ? Number(taskId) : null;
    const existing = db.prepare(
      "SELECT id, attempts FROM event_dlq WHERE status IN ('OPEN','ESCALATED') AND COALESCE(task_id,-1) = COALESCE(?, -1) AND code = ? ORDER BY id DESC LIMIT 1"
    ).get(tid, String(code || ''));
    if (existing) {
      db.prepare('UPDATE event_dlq SET attempts = attempts + 1, message = ?, updated_at = ? WHERE id = ?')
        .run(String(message || '').slice(0, 500), t, existing.id);
      return { ok: true, id: existing.id, duplicate: true };
    }
    const info = db.prepare(`INSERT INTO event_dlq
      (event_id, villa_id, task_id, agent_id, code, message, status, attempts, created_at, updated_at)
      VALUES (?,?,?,?,?,?,'OPEN',0,?,?)`)
      .run(String(eventId || ''), vid, tid, agentId != null ? Number(agentId) : null,
        String(code || '').slice(0, 120), String(message || '').slice(0, 500), t, t);
    const id = Number(info.lastInsertRowid);
    // Spiegelung in den DLQ-Stream (best effort, nie blockierend).
    if (typeof redisTryStreamAdd === 'function') {
      Promise.resolve()
        .then(async () => {
          const streamId = await redisTryStreamAdd(DLQ_STREAM, {
            dlqId: String(id), villaId: vid == null ? '' : String(vid),
            taskId: tid == null ? '' : String(tid), code: String(code || ''), at: String(t),
          });
          if (streamId) db.prepare('UPDATE event_dlq SET stream_id = ? WHERE id = ?').run(String(streamId), id);
        })
        .catch(() => {});
    }
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Nimmt ein Bus-Event an und isoliert es, wenn es einen Fehlschlag meldet. */
export function ingestFailedEvent(event) {
  if (!event || typeof event !== 'object') return { ok: false, error: 'invalid_event' };
  const failed = event.type === 'agent.failed'
    || (event.type === 'task.updated' && String(event.status || '').toUpperCase() === 'FAILED')
    || event.type === 'llm.failed';
  if (!failed) return { ok: true, skipped: true };
  return isolateFailedWorkflow({
    eventId: event.id, villaId: event.villaId, taskId: event.taskId, agentId: event.agentId,
    code: event.code || (event.type === 'llm.failed' ? 'LLM_FAILED' : 'WORKFLOW_FAILED'),
    message: event.status || event.type,
  });
}

/** Requeue eines DLQ-Eintrags: Task zurueck auf PENDING (retry_count+1). */
export function restartFailedWorkflow(id) {
  ensure();
  try {
    const entry = db.prepare('SELECT * FROM event_dlq WHERE id = ?').get(Number(id));
    if (!entry) return { ok: false, error: 'dlq_entry_not_found' };
    if (!OPEN_STATES.includes(entry.status)) return { ok: false, error: 'not_open' };
    const t = Date.now();
    let taskRequeued = false;
    if (entry.task_id) {
      const task = db.prepare('SELECT id, retry_count FROM tasks WHERE id = ?').get(entry.task_id);
      if (task) {
        db.prepare("UPDATE tasks SET status = 'PENDING', retry_count = COALESCE(retry_count,0) + 1, updated_at = ? WHERE id = ?")
          .run(t, task.id);
        taskRequeued = true;
      }
    }
    db.prepare("UPDATE event_dlq SET status = 'REQUEUED', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(t, entry.id);
    return { ok: true, id: entry.id, taskRequeued };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * Alerting-Agent-Takt:
 *  1. FAILED-Tasks mit erreichtem Retry-Limit (>=3) einsammeln und isolieren.
 *  2. Offene DLQ-Eintraege bearbeiten: unter MAX_ATTEMPTS automatisch neu
 *     einreihen, ab MAX_ATTEMPTS eskalieren (Alert, kein Endlos-Retry).
 */
export function dlqTick({ limit = 20, autoRestart = true, failedRetryThreshold = 3 } = {}) {
  ensure();
  const t = Date.now();
  const result = { scanned: 0, isolated: 0, restarted: 0, escalated: 0, alerts: 0, errors: [] };
  try {
    // 1. Gescheiterte Workflows aus der Task-Engine isolieren.
    const dead = db.prepare(`SELECT id, villa_id, agent_id, title, result, retry_count FROM tasks
      WHERE status = 'FAILED' AND COALESCE(retry_count,0) >= ? ORDER BY updated_at DESC LIMIT ?`)
      .all(failedRetryThreshold, limit);
    for (const task of dead) {
      const created = isolateFailedWorkflow({
        villaId: task.villa_id, taskId: task.id, agentId: task.agent_id,
        code: 'TASK_RETRY_EXHAUSTED', message: `${task.title}: ${String(task.result || '').slice(0, 200)}`,
      });
      if (created.ok && !created.duplicate) result.isolated += 1;
      else if (!created.ok) result.errors.push(created.error);
    }
    // 2. Offene Eintraege bearbeiten.
    const open = db.prepare(`SELECT id, villa_id, task_id, code, attempts FROM event_dlq
      WHERE status = 'OPEN' ORDER BY created_at ASC LIMIT ?`).all(limit);
    result.scanned = open.length;
    for (const entry of open) {
      if (autoRestart && entry.attempts < MAX_ATTEMPTS && entry.task_id) {
        const out = restartFailedWorkflow(entry.id);
        if (out.ok) result.restarted += 1; else result.errors.push(out.error);
        continue;
      }
      db.prepare("UPDATE event_dlq SET status = 'ESCALATED', updated_at = ? WHERE id = ?").run(t, entry.id);
      db.prepare('INSERT INTO event_alerts (dlq_id, villa_id, severity, message, created_at) VALUES (?,?,?,?,?)')
        .run(entry.id, entry.villa_id, entry.attempts >= MAX_ATTEMPTS ? 'critical' : 'warn',
          `Workflow ${entry.code} nach ${entry.attempts} Versuchen aufgegeben (Task ${entry.task_id ?? '-'})`, t);
      result.escalated += 1;
      result.alerts += 1;
    }
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, ...result, error: String(error?.message || error) };
  }
}

/** Statusbild fuer API und Diagnose. */
export function dlqStatus({ limit = 20 } = {}) {
  ensure();
  const counts = db.prepare("SELECT status, COUNT(*) n FROM event_dlq GROUP BY status").all();
  const byStatus = Object.fromEntries(counts.map(r => [r.status, Number(r.n)]));
  const oldest = db.prepare("SELECT MIN(created_at) t FROM event_dlq WHERE status IN ('OPEN','ESCALATED')").get();
  return {
    stream: DLQ_STREAM,
    maxAttempts: MAX_ATTEMPTS,
    byStatus,
    open: byStatus.OPEN || 0,
    escalated: byStatus.ESCALATED || 0,
    requeued: byStatus.REQUEUED || 0,
    oldestOpenAt: oldest?.t || null,
    entries: db.prepare('SELECT id, villa_id, task_id, code, status, attempts, message, created_at FROM event_dlq ORDER BY created_at DESC LIMIT ?').all(limit),
    alerts: db.prepare('SELECT id, dlq_id, villa_id, severity, message, created_at, acknowledged_at FROM event_alerts ORDER BY id DESC LIMIT ?').all(limit),
  };
}
