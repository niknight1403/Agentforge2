// ============================================================================
// ROUTEFORGE-AGENT — LLM-Routing- und "No-Limit"-Manager.
//
// Auftrag (Master-Agent-Charta 2026-10-18): Workflows duerfen durch
// Rate-Limits NIE hart unterbrochen werden. Der Hub hat dafuer bereits
// (a) 2-Min-Cooldown je 429-Route, (b) die Offline-Antwort als letzten
// Ausweg und (c) mehrere Keys je Provider (KeyForge). RouteForge ergaenzt
// das adaptive Lastmanagement: Sturm-Routen werden in der Prioritaet
// gesenkt, erholt sich der Provider, wandern sie zurueck zur Basis.
// Villen sortieren im ROTATE-Modus nach Prioritaet -> die Senkung lenkt
// echten Verkehr automatisch auf frische Keys.
//
// Hysterese: degradioert wird nur bei "0 ok / >0 fail" im Fenster (5 Min),
// hochgestuft nur 1 Stufe pro Tick - kein Flattern.
// ============================================================================

import { db } from './db.mjs';
import { forgeLog } from './keyforge.mjs';

const baseline = new Map(); // routeId -> Basis-Prioritaet beim ersten Blick
const last = new Map();     // routeId -> { ok, fail } beim letzten Tick
const MAX_DRIFT = 10;       // hoechstens +10 ueber der Basis

export function routeforgeTick() {
  // Nur Cloud-Routen bewerten (P < 40); Ollama/Kaskade bleiben unberuehrt.
  const rows = db.prepare(
    'SELECT id, name, priority, ok, fail FROM routes WHERE enabled = 1 AND priority < 40'
  ).all();
  const actions = [];
  for (const r of rows) {
    const ok = Number(r.ok) || 0;
    const fail = Number(r.fail) || 0;
    const prev = last.get(r.id);
    last.set(r.id, { ok, fail });
    if (!baseline.has(r.id)) baseline.set(r.id, Number(r.priority) || 10);
    if (!prev) continue;

    const base = baseline.get(r.id);
    const p = Number(r.priority);
    const dOk = ok - prev.ok;
    const dFail = fail - prev.fail;

    // Sturm: seit dem letzten Tick nur Fails -> 2 Stufen runter (begrenzt).
    if (dFail > 0 && dOk === 0 && p < base + MAX_DRIFT) {
      const np = p + 2;
      db.prepare('UPDATE routes SET priority = ? WHERE id = ?').run(np, r.id);
      forgeLog('routeforge:demote', `${r.name} P${p} -> P${np} (Fenster: ok+0, fail+${dFail})`);
      actions.push({ route: r.id, name: r.name, op: 'demote', from: p, to: np });
    }
    // Erholung: Erfolge im Fenster -> 1 Stufe zurueck Richtung Basis.
    else if (dOk > 0 && p > base) {
      const np = Math.max(base, p - 1);
      db.prepare('UPDATE routes SET priority = ? WHERE id = ?').run(np, r.id);
      forgeLog('routeforge:promote', `${r.name} P${p} -> P${np} (Fenster: ok+${dOk})`);
      actions.push({ route: r.id, name: r.name, op: 'promote', from: p, to: np });
    }
  }
  return { actions, watching: rows.length };
}

export function routeforgeStatus() {
  const rows = db.prepare('SELECT id, name, priority, ok, fail, status FROM routes WHERE enabled = 1').all();
  return {
    watching: rows.length,
    baselines: Object.fromEntries(baseline),
    routes: rows.map((r) => ({
      id: r.id, name: r.name, priority: r.priority, ok: r.ok, fail: r.fail, status: r.status
    }))
  };
}
