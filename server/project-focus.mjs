/**
 * Projekt-Fokus fuer den VillaForge-Hub (Nikos Auftrag 2026-11-02).
 *
 * Wunsch: Bestimmte Villen sollen ihr Projekt erst fertigstellen. Solange der
 * Fokus steht, starten keine anderen Villen - weder automatisch noch durch
 * einen manuellen Start. Erst wenn jede Fokus-Villa fertig ist, gibt der Fokus
 * den Betrieb fuer die naechsten Villen wieder frei.
 *
 * Bewusst eng:
 * - Der Fokus blockiert nur STARTS. Laufende Arbeit wird nicht abgebrochen;
 *   das bleibt eine eigene, sichtbare Entscheidung.
 * - Fertig heisst: Status COMPLETED, oder es ist keine offene Aufgabe mehr da.
 * - Der Fokus loest sich selbst auf, sobald alle Fokus-Villen fertig sind.
 *   Ein liegengebliebener Fokus darf den Hub nicht dauerhaft sperren.
 * - Jede Setz- und Aufhebe-Entscheidung landet in project_focus_history,
 *   damit spaeter belegbar ist, warum andere Villen warten mussten.
 */
import { db } from './db.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS project_focus (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  villa_ids TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_focus_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_ids TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

/** Offene Aufgaben einer Villa. */
export function openTaskCount(villaId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY','RUNNING')"
  ).get(Number(villaId));
  return Number(row?.n) || 0;
}

function parseIds(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

/** Ein Villa-Zustand fuer die Fokus-Anzeige. */
export function focusVillaState(villaId) {
  const id = Number(villaId);
  const villa = db.prepare('SELECT id, name, status FROM villas WHERE id = ?').get(id);
  if (!villa) return { id, name: null, status: 'MISSING', open: 0, done: false, existing: false };
  const open = openTaskCount(id);
  const status = String(villa.status || '').toUpperCase();
  const done = status === 'COMPLETED' || (open === 0 && !['RUNNING', 'PAUSED', 'WAITING_FOR_MODEL', 'STOPPING'].includes(status));
  return { id, name: villa.name, status: villa.status, open, done, existing: true };
}

/** Aktive Fokus-Villen (leer = kein Fokus). */
export function focusVillaIds() {
  const row = db.prepare('SELECT villa_ids FROM project_focus WHERE id = 1').get();
  return row ? parseIds(row.villa_ids) : [];
}

export function focusActive() {
  return focusVillaIds().length > 0;
}

/** Darf diese Villa starten? Ohne Fokus: immer. Mit Fokus: nur Fokus-Villen. */
export function focusAllows(villaId) {
  const ids = focusVillaIds();
  return ids.length === 0 || ids.includes(Number(villaId));
}

export function focusStatus() {
  const row = db.prepare('SELECT villa_ids, reason, created_at FROM project_focus WHERE id = 1').get();
  const ids = row ? parseIds(row.villa_ids) : [];
  if (!ids.length) return { active: false, villaIds: [], villas: [], open: 0, ready_to_release: true, reason: null, since: null };
  const villas = ids.map(focusVillaState);
  return {
    active: true,
    villaIds: ids,
    villas,
    open: villas.reduce((sum, villa) => sum + (villa.done ? 0 : villa.open), 0),
    ready_to_release: villas.every((villa) => villa.done || !villa.existing),
    reason: row.reason || null,
    since: Number(row.created_at) || null
  };
}

/** Setzt den Fokus. Wirft bei unbrauchbaren Angaben, statt still nichts zu tun. */
export function setVillaFocus(villaIds, { reason = '', now = Date.now() } = {}) {
  const ids = [...new Set((Array.isArray(villaIds) ? villaIds : [villaIds]).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) throw new Error('Mindestens eine Villa fuer den Fokus angeben.');
  const missing = ids.filter((id) => !db.prepare('SELECT id FROM villas WHERE id = ?').get(id));
  if (missing.length) throw new Error('Unbekannte Villa(s): ' + missing.join(', '));
  const payload = JSON.stringify(ids);
  db.prepare('INSERT OR REPLACE INTO project_focus(id, villa_ids, reason, created_at) VALUES (1, ?, ?, ?)')
    .run(payload, String(reason || '').slice(0, 300), now);
  db.prepare('INSERT INTO project_focus_history(villa_ids, reason, action, created_at) VALUES (?,?,?,?)')
    .run(payload, String(reason || '').slice(0, 300), 'set', now);
  return focusStatus();
}

export function clearVillaFocus({ reason = '', now = Date.now() } = {}) {
  const row = db.prepare('SELECT villa_ids FROM project_focus WHERE id = 1').get();
  db.prepare('DELETE FROM project_focus WHERE id = 1').run();
  if (row) {
    db.prepare('INSERT INTO project_focus_history(villa_ids, reason, action, created_at) VALUES (?,?,?,?)')
      .run(row.villa_ids, String(reason || '').slice(0, 300), 'clear', now);
  }
  return focusStatus();
}

/**
 * Loest den Fokus auf, sobald jede Fokus-Villa fertig ist.
 * Wird vor jeder Startentscheidung aufgerufen, damit ein vergessener Fokus
 * den Betrieb nicht dauerhaft blockiert.
 */
export function releaseFocusIfComplete({ now = Date.now() } = {}) {
  const status = focusStatus();
  if (!status.active || !status.ready_to_release) return status;
  return clearVillaFocus({ reason: 'Fokus automatisch beendet: alle Fokus-Villen sind fertig.', now });
}

/** Freigabe-Entscheidung: reine Auskunft, ohne Nebenwirkung. */
export function focusDecision(villaId) {
  const ids = focusVillaIds();
  if (!ids.length) return { allowed: true };
  if (ids.includes(Number(villaId))) return { allowed: true };
  return {
    allowed: false,
    code: 'FOCUS_ACTIVE',
    message:
      'Projekt-Fokus aktiv: zuerst werden ' + ids.map((id) => '#' + id).join(', ') +
      ' fertiggestellt. Weitere Villen starten erst, wenn diese Projekte abgeschlossen sind.'
  };
}

/** Verlauf (neueste zuerst) - fuer ehrliche Nachvollziehbarkeit. */
export function focusHistory(limit = 20) {
  return db.prepare('SELECT id, villa_ids, reason, action, created_at FROM project_focus_history ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(limit) || 20)));
}
