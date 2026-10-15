/**
 * Wartungs-Funktionen: alte Daten aufrueumen.
 *
 * Audit-Eintraege (Werkzeugprotokoll) und Nachrichten (Chatverlauf)
 * wachsen unbegrenzt. pruneOldData entfernt alles, was aelter als
 * `days` Tage ist — im Trockenlauf nur gezaehlt, sonst geloescht.
 * Aufgaben, Agenten, Gedaechtnis und Berichte bleiben unberuehrt:
 * das ist Arbeitsinhalt, kein Protokoll.
 */
import { db, now } from './db.mjs';
import { emit } from './events.mjs';
import { enqueueVillas, configureScheduler } from './scheduler.mjs';

export function pruneOldData({ days, dryRun = false } = {}) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1 || d > 3650) {
    return { ok: false, error: 'days muss zwischen 1 und 3650 liegen' };
  }
  const cutoff = Date.now() - d * 86400000;
  const out = { ok: true, dryRun: !!dryRun, days: Math.round(d), cutoff, deleted: {} };

  for (const [table, column] of [['audit', 'ts'], ['messages', 'created_at']]) {
    const count = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${column} < ?`).get(cutoff).c;
    if (!dryRun && count > 0) {
      db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff);
    }
    out.deleted[table] = count;
  }
  out.deleted.total = out.deleted.audit + out.deleted.messages;

  // Nach dem Loeschen: SQLite-Hausputz — geloeschte Seiten zurueckgeben,
  // Statistiken auffrischen und WAL in die DB zurückschreiben.
  if (!dryRun) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('PRAGMA optimize;');
  }
  out.optimized = !dryRun;
  return out;
}

/**
 * Automatische Fortsetzung pausierter Laeufe, deren einzige Fehlerursache
 * erschöpfte Gratis-Kontingente (429) waren. villas.auto_retry_at haelt den
 * faelligen Zeitpunkt; hier setzt der Hub die Villa selbst wieder an —
 * ohne Klick auf Retry und ohne externen Weckruf.
 */
export function autoResumeQuotaVillas({ orchestrate, isRunning } = {}) {
  const due = db.prepare(
    "SELECT id FROM villas WHERE status = 'PAUSED' AND auto_retry_at > 0 AND auto_retry_at <= ?"
  ).all(now());
  const out = { checked: due.length, resumed: [], cleared: [], skipped: [] };
  for (const { id } of due) {
    if (isRunning?.(id)) { out.skipped.push(id); continue; }
    const blocked = db.prepare(
      "SELECT id FROM tasks WHERE villa_id = ? AND status = 'FAILED' AND quota_blocked = 1"
    ).all(id);
    // Zwischenzeitlich von Hand behoben oder Aufgaben weg — Flag aufraeumen.
    if (blocked.length === 0) {
      db.prepare('UPDATE villas SET auto_retry_at = 0, updated_at = ? WHERE id = ?').run(now(), id);
      out.cleared.push(id);
      continue;
    }
    db.prepare(
      "UPDATE tasks SET status = 'PENDING', result = '', quota_blocked = 0, updated_at = ? WHERE villa_id = ? AND status = 'FAILED' AND quota_blocked = 1"
    ).run(now(), id);
    db.prepare('UPDATE villas SET auto_retry_at = 0, updated_at = ? WHERE id = ?').run(now(), id);
    db.prepare('INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,?)')
      .run(now(), id, 0, 'auto_resume', JSON.stringify({ count: blocked.length }),
        blocked.length + ' kontingent-blockierte Aufgabe(n) automatisch erneut gestartet', 1);
    emit('tasks_requeued', { villaId: id, count: blocked.length, auto: true });
    if (typeof orchestrate === 'function') {
      // Ueber den Scheduler: respektiert die Slot-Grenze und den Fortschrittsrang.
      configureScheduler({ start: (vid) => orchestrate(vid, { concurrency: 4, maxTasks: 500, adaptive: true, maxRounds: 6 }) });
      enqueueVillas([id]);
    }
    out.resumed.push(id);
  }
  return out;
}
