/**
 * Villa-Scheduler: bis zu drei Villen laufen parallel; weitere warten fair in der Queue.
 *
 * Problem: Nach einem Neustart setzte der Hub alle unterbrochenen Villen
 * gleichzeitig fort (11 Villen x 4 Agenten). Auf 4 Kernen mit einem einzigen
 * Ollama endet das im Dauerstau, und selbst /api/health antwortet nicht mehr.
 *
 * Loesung: Es laufen standardmaessig drei Villen gleichzeitig. Weitere Laeufe
 * bleiben einzeln steuerbar und warten in einer fairen Queue.
 * Die Reihenfolge bestimmt der Fortschritt: Villen, die am weitesten sind,
 * werden zuerst fertig gebaut; danach rueckt die naechste nach. Dadurch
 * entstehen schneller vollstaendige Ergebnisse statt vieler halbfertiger.
 *
 * Rang einer Villa (hoeher = frueher):
 *   Fortschritt (erledigt / gesamt) dominiert, wenig Restarbeit gewinnt bei
 *   Gleichstand, und Villen mit Fehlern fallen leicht zurueck.
 */
import { db } from './db.mjs';
import { getSetting } from './control-store.mjs';
import { orchestrate } from './agents.mjs';

// Fokus laesst sich weiterhin explizit fuer laengere Projektlaeufe aktivieren,
// begrenzt aber nicht mehr die Zahl manuell startbarer Villen.
export function villaFocusId() {
  const id = Number(getSetting('villaFocusId', 0));
  return Number.isSafeInteger(id) && id > 0 && db.prepare('SELECT id FROM villas WHERE id=?').get(id) ? id : null;
}
export const FOCUS_MODE = () => villaFocusId() !== null || process.env.VF_FOCUS_MODE === '1';
const finishModeKey = (id) => `villaFinishBeforeRotation:${Number(id)}`;
export function villaRunToCompletion(id) {
  const raw = db.prepare('SELECT value FROM control_settings WHERE key=?').get(finishModeKey(id))?.value;
  try { return JSON.parse(raw) === true; } catch { return raw === 'true' || raw === '1'; }
}
export function setVillaRunToCompletion(id, enabled) {
  const key = finishModeKey(id);
  if (enabled) db.prepare('INSERT OR REPLACE INTO control_settings(key,value) VALUES (?,?)').run(key, 'true');
  else db.prepare('DELETE FROM control_settings WHERE key=?').run(key);
  return villaRunToCompletion(id);
}
const SLOTS = () => Math.max(1, Math.min(4, Number(getSetting('villaSlots', process.env.VF_VILLA_SLOTS ?? 3)) || 3));

/** Fortschritt und Rang aller Villen in einer einzigen Abfrage. */
export function villaRanking() {
  const rows = db.prepare(`
    SELECT v.id, v.name, v.status, v.autonomy,
           COALESCE(SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END), 0) AS done,
           COALESCE(SUM(CASE WHEN t.status IN ('PENDING','READY','RUNNING') THEN 1 ELSE 0 END), 0) AS open,
           COALESCE(SUM(CASE WHEN t.status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed,
           COUNT(t.id) AS total
    FROM villas v LEFT JOIN tasks t ON t.villa_id = v.id
    GROUP BY v.id`).all();
  return rows
    .map((r) => {
      const progress = r.total > 0 ? r.done / r.total : 0;
      // Fortschritt zaehlt am meisten, Fehler kosten etwas, wenig Rest hilft.
      const failPenalty = r.total > 0 ? (r.failed / r.total) * 0.25 : 0;
      const restBonus = r.open > 0 ? 1 / (r.open + 10) : 0;
      return { ...r, progress: Math.round(progress * 1000) / 1000, rank: progress - failPenalty + restBonus };
    })
    .sort((a, b) => b.rank - a.rank || a.id - b.id);
}

const queue = [];          // wartende Villa-IDs in der Reihenfolge der Startanforderung
const active = new Set();  // Villen, die gerade einen Slot halten
const lastStart = new Map(); // villaId -> Zeitpunkt des letzten Starts (Anti-Streben)
let starter = null;        // Funktion (villaId) => Promise, die den Lauf startet

/** Setzt die Startfunktion (orchestrate) - vermeidet zyklische Importe. */
export function configureScheduler({ start }) {
  starter = start;
}

export function schedulerStatus() {
  return {
    focusMode: FOCUS_MODE(),
    focusVillaId: villaFocusId(),
    slots: SLOTS(),
    active: [...active],
    queued: queue.length,
    queue: queue.slice(),
    lastStart: Object.fromEntries(lastStart)
  };
}

/** Entfernt einen wartenden Lauf ohne andere Villen oder Slots anzuhalten. */
export function cancelScheduledVilla(id) {
  const index = queue.indexOf(Number(id));
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

function pump() {
  while (starter && active.size < SLOTS() && queue.length) {
    const id = queue.shift();
    if (active.has(id) || db.prepare('SELECT status FROM villas WHERE id=?').get(id)?.status === 'ARCHIVED') continue;
    active.add(id);
    lastStart.set(id, Date.now());
    // Synchron starten: Aufrufer (Tests, Auto-Resume) sehen den Start sofort.
    try {
      const result = starter(id);
      Promise.resolve(result)
        .catch((err) => console.error(`[villaforge] Scheduler: Villa ${id} fehlgeschlagen:`, err?.message || err))
        .finally(() => {
          active.delete(id);
          pump();
        });
    } catch (err) {
      active.delete(id);
      console.error(`[villaforge] Scheduler: Villa ${id} fehlgeschlagen:`, err?.message || err);
    }
  }
}

/**
 * Reiht Villen ein. Bereits aktive oder wartende werden uebersprungen.
 * Die Warteschlange wird nach aktuellem Fortschritt sortiert.
 */
export function enqueueVillas(ids) {
  for (const id of ids) {
    const villaId = Number(id);
    if (Number.isSafeInteger(villaId) && villaId > 0 && !active.has(villaId) && !queue.includes(villaId)) queue.push(villaId);
  }
  pump();
  return schedulerStatus();
}

/** Einheitlicher Einstieg: alle automatischen und manuellen Starts laufen
 *  ueber denselben Scheduler (Default 3 Slots). */
export function scheduleVilla(id, { concurrency = 0, maxRounds = 6, runToCompletion = true } = {}) {
  if (runToCompletion) setVillaRunToCompletion(id, true);
  configureScheduler({ start: (vid) => orchestrate(vid, { concurrency, maxRounds, runToCompletion: villaRunToCompletion(vid) }) });
  const status = enqueueVillas([id]);
  return status;
}

/** Test-Hilfe: Zustand zuruecksetzen. */
export function _resetScheduler() {
  queue.length = 0;
  active.clear();
  starter = null;
}
