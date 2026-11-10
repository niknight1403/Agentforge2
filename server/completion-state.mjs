/*
 * completion-state (2026-11-10, Villa-Audit): "COMPLETED" muss bedeuten, dass
 * keine Arbeit mehr offen ist. Der Abschluss wird im Lauf gesetzt, wenn keine
 * offene Aufgabe mehr existiert; danach koennen jedoch Verbesserungswellen,
 * Ratsbeschluesse oder Reparaturauftraege neue Aufgaben anlegen. Der Status
 * blieb dann faelschlich auf COMPLETED - im Produktions-Audit waren so Villen
 * mit 3, 77 und 88 offenen Aufgaben als "fertig" ausgewiesen.
 *
 * Diese Abstimmung macht den Zustand ehrlich: eine Villa mit offener Arbeit
 * verlaesst COMPLETED und wird PAUSED. Die Autonomie-Einstellung des Besitzers
 * bleibt unveraendert - der Hub startet nichts von selbst neu.
 */
import { db, now } from './db.mjs';
import { emit } from './events.mjs';

/**
 * Offene Arbeit ist alles, was nicht ausdruecklich abgeschlossen oder
 * abgebrochen ist - dieselbe Definition wie im Villa-Audit, damit Status und
 * Pruefung nie auseinanderlaufen. FAILED zaehlt mit: eine gescheiterte Aufgabe
 * ist keine erledigte Aufgabe.
 */
export const CLOSED_TASK_STATUSES = Object.freeze(['DONE', 'CANCELLED', 'CANCELED']);

/**
 * Setzt COMPLETED auf PAUSED zurueck, sobald wieder offene Aufgaben existieren.
 * Idempotent: ein zweiter Aufruf findet nichts mehr zu tun.
 */
export function reconcileCompletionStates({ limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT v.id AS id, COUNT(t.id) AS open, v.autonomy AS autonomy
      FROM villas v
      JOIN tasks t ON t.villa_id = v.id AND t.status NOT IN (${CLOSED_TASK_STATUSES.map(() => '?').join(',')})
     WHERE v.status = 'COMPLETED'
     GROUP BY v.id
     ORDER BY v.id
     LIMIT ?`).all(...CLOSED_TASK_STATUSES, Math.max(1, Number(limit) || 100));

  const reopened = [];
  for (const row of rows) {
    const changed = db.prepare("UPDATE villas SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'COMPLETED'")
      .run(now(), row.id);
    if (!changed.changes) continue;
    reopened.push({ villaId: Number(row.id), openTasks: Number(row.open) });
    emit('villa', { villaId: Number(row.id), status: 'PAUSED', reason: 'COMPLETION_REOPENED', openTasks: Number(row.open) });
  }
  return { checked: rows.length, reopened };
}
