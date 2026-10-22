/**
 * AUTOPILOT (v1.45.0 — Nutzerdirektive 2026-10-22: "integriere einen Autopiloten").
 *
 * Autonomer Flotten-Regler im 5-Minuten-Takt (Setting 'autopilot' = 0 schaltet
 * ihn ab, 'autopilotInterval' Min, Default 5). Er haelt die 24/7-Flotte im
 * Gleichgewicht, ohne dass ein Mensch eingreifen muss:
 *
 *   1. SCORING: neue DONE-Aufgaben bewerten (Scorer, 0€-Heuristik) und
 *      Villa-Produktivitaet aktualisieren.
 *   2. SLOT-FILLING: freie Scheduler-Slots mit den produktivsten Villen
 *      belegen (Scorer-Prioritaet), damit die 5 Slots nie leer stehen.
 *   3. ORPHAN-RESCUE: RUNNING-Aufgaben von Villen OHNE aktiven Lauf (nach
 *      Absturz/Pause) frueh zurueck in den Pool — kein 90-Min-Warten mehr
 *      auf den Zombie-Reaper fuer lebendig aussehende Leichname.
 *   4. ROUTE-HEALING: Fehler-Zaehler aktiver Routen nach Ruhepausen
 *      zuruecksetzen (nach Laststuermen sind die Routen gesund, nur die
 *      Statistik ist es nicht).
 *   5. LOCAL-FIRST-REPORT: Verhaeltnis lokale vs. Cloud-Route taeglich
 *      sichtbar machen (Mandat: 80-90% lokal, 0€ variable Kosten).
 *
 * Alles in try/catch: Der Autopilot darf den Hub-Takt niemals blockieren.
 */
import { db, now } from './db.mjs';
import { getSetting } from './control-store.mjs';
import { schedulerStatus, enqueueVillas } from './scheduler.mjs';
import { scoreRecentTasks, villaScores } from './scorer.mjs';

const LOCAL_HINTS = ['2.31.', '2.28.', '10.', '192.168.', '127.0.0.1', 'localhost'];

const log = (msg) => console.log(`[villaforge] Autopilot: ${msg}`);

/** Eine Autopilot-Runde. Gibt die ausgefuehrten Aktionen zurueck (fuer Log/Tests). */
export function autopilotTick({ slots = null } = {}) {
  const actions = [];
  if (Number(getSetting('autopilot', process.env.VF_AUTOPILOT ?? 1)) !== 1) return actions;

  // 1) Scoring — neue fertige Aufgaben bewerten, Villa-Scores aktualisieren.
  try {
    const scored = scoreRecentTasks({ limit: 40 });
    const villas = villaScores();
    if (scored) actions.push(`scored:${scored} Tasks`);
    // 2) Slot-Filling — freie Slots mit den besten Villen belegen.
    const st = schedulerStatus();
    const maxSlots = slots ?? st.slots;
    const free = Math.max(0, maxSlots - st.active.length - st.queued);
    if (free > 0) {
      const activeSet = new Set([...st.active, ...(st.queue || [])]);
      const candidates = villas
        .filter((v) => v.autonomy === 1 && v.open > 0 && v.status !== 'ARCHIVED' && !activeSet.has(v.villaId))
        .slice(0, free)
        .map((v) => v.villaId);
      if (candidates.length) {
        enqueueVillas(candidates);
        actions.push(`slots gefuellt: Villa ${candidates.join(', ')}`);
      }
    }
  } catch (e) { actions.push(`scoring/slots FEHLER: ${String(e?.message || e).slice(0, 120)}`); }

  // 3) Orphan-Rescue — RUNNING-Tasks ohne aktiven Lauf frueh zurueckstellen.
  try {
    const st = schedulerStatus();
    const activeSet = new Set(st.active);
    const cutoff = now() - 5 * 60_000;
    const orphans = db.prepare(`
      SELECT t.id, t.villa_id FROM tasks t
      WHERE t.status = 'RUNNING' AND t.updated_at < ?`).all(cutoff);
    const fixable = orphans.filter((o) => !activeSet.has(o.villa_id));
    if (fixable.length) {
      const upd = db.prepare("UPDATE tasks SET status = 'PENDING', result = COALESCE(result,'') || ' [Autopilot-Rescue]', updated_at = ? WHERE id = ? AND status = 'RUNNING'");
      for (const o of fixable) upd.run(now(), o.id);
      actions.push(`orphan-rescue: ${fixable.length} Task(s) (${[...new Set(fixable.map((o) => 'V' + o.villa_id))].join(', ')})`);
    }
  } catch (e) { actions.push(`orphan-rescue FEHLER: ${String(e?.message || e).slice(0, 120)}`); }

  // 4) Route-Healing — Fehler-Zaehler beruhigter, aktiver Routen nach 10 Min Ruhe zuruecksetzen.
  try {
    const healed = db.prepare(`
      UPDATE routes SET ok = 1, fail = 0, status = 'OK', cooldown_until = 0
      WHERE enabled = 1 AND fail > 0 AND cooldown_until < ? AND last_used < ?`)
      .run(now(), now() - 10 * 60_000);
    if (healed.changes) actions.push(`${healed.changes} Route(n) geheilt`);
  } catch (e) { actions.push(`route-heal FEHLER: ${String(e?.message || e).slice(0, 120)}`); }

  return actions;
}

/** Local-First-Verhaeltnis (lokale vs. Cloud-Route-Nutzung) — Report-Tabelle. */
export function localFirstReport() {
  const rows = db.prepare('SELECT base_url, ok, fail FROM routes WHERE enabled = 1').all();
  let local = { ok: 0, fail: 0, n: 0 }, cloud = { ok: 0, fail: 0, n: 0 };
  for (const r of rows) {
    const isLocal = LOCAL_HINTS.some((h) => r.base_url.startsWith('http://' + h) || r.base_url.includes('localhost'));
    const b = isLocal ? local : cloud;
    b.ok += r.ok; b.fail += r.fail; b.n++;
  }
  const totalOk = local.ok + cloud.ok || 1;
  return { local, cloud, localSharePct: Math.round((local.ok / totalOk) * 100) };
}

/** Autopilot starten: sofort ein Takt, dann im Intervall. */
export function startAutopilot() {
  const intervalMin = Math.max(2, Number(getSetting('autopilotInterval', process.env.VF_AUTOPILOT_INTERVAL ?? 5)) || 5);
  const run = () => {
    try {
      const actions = autopilotTick();
      if (actions.length) log(actions.join(' | '));
    } catch (e) { /* Autopilot blockiert den Hub nie */ }
  };
  setTimeout(run, 90 * 1000).unref?.();
  const loop = setInterval(run, intervalMin * 60_000);
  loop.unref();
  log(`aktiv (Takt ${intervalMin} Min, Scorer lokal-heuristisch, Local-First). Start: ${localFirstReport().localSharePct}% lokale Route-Nutzung.`);
  return loop;
}
