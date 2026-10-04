/**
 * Wartungs-Funktionen: alte Daten aufrueumen.
 *
 * Audit-Eintraege (Werkzeugprotokoll) und Nachrichten (Chatverlauf)
 * wachsen unbegrenzt. pruneOldData entfernt alles, was aelter als
 * `days` Tage ist — im Trockenlauf nur gezaehlt, sonst geloescht.
 * Aufgaben, Agenten, Gedaechtnis und Berichte bleiben unberuehrt:
 * das ist Arbeitsinhalt, kein Protokoll.
 */
import { db } from './db.mjs';

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
  return out;
}
