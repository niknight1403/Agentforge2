/**
 * Villa-Scheduler: nicht alle Villen gleichzeitig, sondern die weitesten zuerst.
 *
 * Problem: Nach einem Neustart setzte der Hub alle unterbrochenen Villen
 * gleichzeitig fort (11 Villen x 4 Agenten). Auf 4 Kernen mit einem einzigen
 * Ollama endet das im Dauerstau, und selbst /api/health antwortet nicht mehr.
 *
 * Loesung: Es laufen hoechstens VF_VILLA_SLOTS Villen gleichzeitig (Default 2).
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

// v1.42.0 — FOKUS-MODUS (Nutzerdirektive 2026-10-18): "Die Villen sollen nicht
// staendig rotieren, sondern Projekt fuer Projekt fertigstellen." Der Fokus-Modus
// ist Standard: Genau EINE Villa laeuft (die fortschrittlichste zuerst) und wird
// erst fertig gebaut, bevor die naechste startet. Rotation (VF_VILLA_SLOTS > 1)
// gibt es nur noch bei explizitem VF_FOCUS_MODE=0.
export const FOCUS_MODE = () => process.env.VF_FOCUS_MODE !== '0';
const SLOTS = () => (FOCUS_MODE() ? 1 : Math.max(1, Number(getSetting('villaSlots', process.env.VF_VILLA_SLOTS ?? 1)) || 1));

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

const queue = [];          // wartende Villa-IDs (faire Reihenfolge, Rang als Stichbrecher)
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
    slots: SLOTS(),
    active: [...active],
    queued: queue.length,
    queue: queue.slice(0, 20),
    lastStart: Object.fromEntries(lastStart)
  };
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
  const rank = new Map(villaRanking().map((r, i) => [r.id, i]));
  for (const id of ids) {
    if (!active.has(id) && !queue.includes(id)) queue.push(id);
  }
  // Faire Reihenfolge: wer am laengsten nicht mehr dran war, kommt zuerst.
  // Der Rang bricht nur Gleichstand - sonst verhungern niedrig gerankte
  // Villen dauerhaft, weil hohergerankte nach jedem Lauf wieder vor drängen.
  queue.sort((a, b) => (lastStart.get(a) ?? 0) - (lastStart.get(b) ?? 0) || (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  pump();
  return schedulerStatus();
}

/** v1.40.0 — Einheitlicher Einstieg: Villen laufen NIEMALS direkt, sondern
 *  immer ueber den Scheduler (strikte Reihenfolge, Default 1 Slot). */
export function scheduleVilla(id, { concurrency = 0, maxRounds = 6 } = {}) {
  configureScheduler({ start: (vid) => orchestrate(vid, { concurrency, maxRounds }) });
  const status = enqueueVillas([id]);
  return status;
}

/** Test-Hilfe: Zustand zuruecksetzen. */
export function _resetScheduler() {
  queue.length = 0;
  active.clear();
  starter = null;
}
