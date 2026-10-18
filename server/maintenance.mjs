/**
 * Wartung: Historien-Rotation und Altdaten-Bereinigung.
 *
 * Laeufe schreiben ohne Rotationsgrenze: jede Agenten-Nachricht und jeder
 * Werkzeugaufruf landet in der DB. Nach wenigen Tagen standen dort
 * ~38.000 Nachrichten und Audit-Zeilen (157 MB) - und machten jede Abfrage
 * langsamer. Zwei Grenzen halten die Villa dauerhaft schnell:
 *
 *   1. pruneHistory (je Lauf-Ende): audit/memories je Villa auf Fenster
 *      kuerzen, wichtige Erinnerungen (importance >= 8) ueberleben immer.
 *   2. maintenanceTick (Intervall + Endpunkt): Alte Chatverlaeufe und
 *      Audit-Protokolle ab einer Mindestalter loeschen, danach WAL
 *      zurueckschreiben und Statistiken auffrischen.
 *
 * Aufgaben, Agenten, Berichte und Rat-Protokolle sind Arbeitsinhalt und
 * bleiben unberuehrt.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, now } from './db.mjs';

export function pruneHistory(villaId, { keepAudit = 400, keepMemories = 300, keepMessages = 500 } = {}) {
  const audit = db.prepare(`
    DELETE FROM audit WHERE villa_id = ? AND id NOT IN (
      SELECT id FROM audit WHERE villa_id = ? ORDER BY id DESC LIMIT ?)`).run(villaId, villaId, keepAudit).changes;
  const mem = db.prepare(`
    DELETE FROM memories WHERE villa_id = ? AND id NOT IN (
      SELECT id FROM memories WHERE villa_id = ?
        ORDER BY (importance >= 8) DESC, importance DESC, id DESC LIMIT ?)`).run(villaId, villaId, keepMemories).changes;
  // Chatverlaeufe sind das groesste Wachstum im Dauerbetrieb (37.000+ Zeilen):
  // je Villa bleibt das letzte Fenster, aeltere Dialoge gehen.
  const msgs = db.prepare(`
    DELETE FROM messages WHERE villa_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE villa_id = ? ORDER BY id DESC LIMIT ?)`).run(villaId, villaId, keepMessages).changes;
  return { audit, memories: mem, messages: msgs };
}

export function pruneOldData({ days = 30, dryRun = false } = {}) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1 || d > 3650) {
    return { ok: false, error: 'days muss zwischen 1 und 3650 liegen' };
  }
  const cutoff = now() - d * 86_400_000;
  const out = { ok: true, dryRun: !!dryRun, days: Math.round(d), deleted: {} };
  for (const [table, column] of [['audit', 'ts'], ['messages', 'created_at']]) {
    const count = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${column} < ?`).get(cutoff).c;
    if (!dryRun && count > 0) {
      db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff);
    }
    out.deleted[table] = count;
  }
  out.deleted.total = out.deleted.audit + out.deleted.messages;
  if (!dryRun) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('PRAGMA optimize;');
  }
  out.optimized = !dryRun;
  return out;
}

/** Kompletter Wartungstakt: alle Villen rotieren, Altdaten raus, kompaktieren. */
export function maintenanceTick({ days = 30, dryRun = false } = {}) {
  const villas = db.prepare('SELECT id FROM villas').all();
  let audit = 0, memories = 0, messages = 0;
  if (!dryRun) {
    for (const v of villas) {
      const r = pruneHistory(v.id);
      audit += r.audit; memories += r.memories; messages += r.messages;
    }
  }
  const old = pruneOldData({ days, dryRun });

  // Geloeschte Zeilen befreien die Datei nicht automatisch: SQLite haelt die
  // Seiten als freien Platz vor. VACUUM gibt sie erst wirklich an das
  // Dateisystem zurueck - die DB schrumpfte inhaltlich auf ein Drittel,
  // blieb aber 183 MB gross. Nur lohnen, wenn wirklich viel wegfiel.
  let vacuumed = false;
  if (!dryRun && old.deleted.total + audit + memories + messages > 500) {
    try { db.exec('VACUUM;'); vacuumed = true; } catch { /* laufende Nutzung: naechster Takt */ }
  }
  return {
    ok: true, dryRun: !!dryRun, villas: villas.length,
    rotated: { audit, memories, messages },
    deleted: old.deleted,
    vacuumed,
    db: dbSize()
  };
}

/** Groesse der Datenbank-Dateien in Bytes (fuer Health und Berichte). */
export function dbSize() {
  const dbPath = process.env.VF_DB || resolve(process.cwd(), 'server/data/villaforge.db');
  let main = 0, wal = 0;
  try { main = statSync(dbPath).size; } catch { /* keine DB */ }
  try { wal = statSync(dbPath + '-wal').size; } catch { /* kein WAL */ }
  return { main, wal };
}
