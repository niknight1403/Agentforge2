/**
 * ROUTEN-STUDIO — Elite-Paket, Ketten-Simulation und Agenten-Auftraege.
 *
 * Zweck: Der Nutzer soll in einem sichtbaren Bereich einen Agenten anweisen,
 * aus den vorhandenen kostenlosen Routen eine belastbare Kette zu bauen
 * ("Elite-Paket") und diese vor dem Aktivieren zu simulieren.
 *
 * Bewusste Grenzen (dokumentiert, damit niemand mehr erwartet als gebaut ist):
 *  - Es werden KEINE fremden Quoten umgangen. Cooldowns und Priority kommen
 *    aus den real gemessenen Werten (ok/fail/lat_ms/cooldown_until).
 *  - "No-Limit" ist keine Garantie, sondern das Ergebnis mehrerer unabhaengiger
 *    Provider und sauberem Failover. Ist alles erschoepft, bleibt der Offline-
 *    Pfad des Hubs die ehrliche Antwort.
 *  - Aenderungen sind versioniert (route_chains) und protokolliert (forgeLog),
 *    damit Rat, Healer und Nutzer nachvollziehen koennen, warum eine Kette so
 *    aussieht.
 */
import { db, now } from './db.mjs';
import { forgeLog } from './keyforge.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS route_chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  preset TEXT NOT NULL DEFAULT 'elite',
  steps TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS route_chain_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER,
  simulated_at INTEGER NOT NULL,
  steps INTEGER NOT NULL DEFAULT 0,
  expected_ok REAL NOT NULL DEFAULT 0,
  expected_lat_ms REAL NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
);`);

/** Kennzahl einer Route: 0..100. Beruecksichtigt Erfolgsquote, Tempo, Frische. */
export function scoreRoute(r) {
  const ok = Number(r.ok || 0);
  const fail = Number(r.fail || 0);
  const total = ok + fail;
  const successRate = total > 0 ? ok / total : (Number(r.enabled) ? 0.5 : 0);
  const lat = Number(r.lat_ms || 0);
  // Tempo: 200 ms = 1.0, 8000 ms = 0.1; unbekannt = neutral 0.4
  const speed = lat > 0 ? Math.max(0.1, Math.min(1, 200 / lat)) : 0.4;
  const alive = Number(r.dead) ? 0 : 1;
  const cooling = Number(r.cooldown_until || 0) > now() ? 0.3 : 1;
  const raw = (successRate * 0.55 + speed * 0.35 + (Number(r.enabled) ? 0.1 : 0)) * alive * cooling;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

/**
 * Elite-Paket: die besten verfuegbaren Routen, gruppiert nach Modellfamilie,
 * damit ein Ausfall eines Providers nicht die ganze Kette mitnimmt.
 */
export function eliteRanking({ limit = 8, onlyFree = true, excludeDead = true } = {}) {
  const rows = db.prepare('SELECT * FROM routes').all()
    .filter((r) => (onlyFree ? Number(r.is_free) === 1 : true))
    .filter((r) => (excludeDead ? !Number(r.dead) : true))
    .map((r) => ({ ...r, score: scoreRoute(r) }))
    .sort((a, b) => b.score - a.score || Number(a.priority) - Number(b.priority));

  const picked = [];
  const providerCount = new Map();
  for (const r of rows) {
    const key = `${r.provider}`;
    if ((providerCount.get(key) || 0) >= 3) continue; // max 3 Slots je Provider
    picked.push(r);
    providerCount.set(key, providerCount.get(key) + 1);
    if (picked.length >= limit) break;
  }
  return picked.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    name: r.name,
    provider: r.provider,
    model: r.model,
    score: r.score,
    lat_ms: Number(r.lat_ms || 0) || null,
    successRate: Number(r.ok || 0) + Number(r.fail || 0) > 0
      ? Math.round((Number(r.ok) / (Number(r.ok) + Number(r.fail))) * 1000) / 10
      : null,
    hasKey: !!String(r.key_env || '').trim(),
  }));
}

/**
 * Simuliert eine Kette: Wie wahrscheinlich kommt eine Anfrage durch, und wie
 * lange dauert sie im Mittel? Reine Rechnung auf gemessenen Werten, keine
 * echten Aufrufe (Trockenlauf).
 */
export function simulateChain(steps = []) {
  const plan = steps.map((s) => {
    const r = db.prepare('SELECT * FROM routes WHERE id = ?').get(Number(s.routeId ?? s.id));
    if (!r) return { ...s, missing: true };
    const ok = Number(r.ok || 0);
    const fail = Number(r.fail || 0);
    const total = ok + fail;
    // Unbekannte Route: vorsichtig annehmen, dass sie funktioniert.
    const p = total > 0 ? Math.max(0.02, Math.min(0.99, ok / total)) : 0.7;
    return {
      routeId: r.id,
      name: r.name,
      provider: r.provider,
      model: r.model,
      pOk: Math.round(p * 1000) / 1000,
      lat_ms: Number(r.lat_ms || 0) || null,
      cooling: Number(r.cooldown_until || 0) > now(),
      dead: !!Number(r.dead),
      score: scoreRoute(r),
    };
  });

  // Durchkommen = 1 - Produkt aller Ausfallwahrscheinlichkeiten.
  let missAll = 1;
  let latSum = 0;
  let used = 0;
  for (const s of plan) {
    if (s.missing || s.dead) continue;
    if (s.cooling) continue;
    missAll *= 1 - s.pOk;
    if (s.lat_ms) { latSum += s.lat_ms; used += 1; }
  }
  const expectedOk = Math.round((1 - missAll) * 1000) / 10;
  const expectedLat = used ? Math.round(latSum / used) : null;
  return {
    steps: plan.length,
    usable: plan.filter((s) => !s.missing && !s.dead && !s.cooling).length,
    expectedOkPercent: expectedOk,
    expectedLatencyMs: expectedLat,
    plan,
  };
}

/** Legt eine Kette an oder aktualisiert sie (Vorschlag bleibt inaktiv). */
export function saveChain({ name, preset = 'elite', steps = [], note = '', active = false }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Name fehlt');
  const t = now();
  const existing = db.prepare('SELECT id FROM route_chains WHERE name = ?').get(clean);
  if (existing) {
    db.prepare('UPDATE route_chains SET preset=?, steps=?, note=?, active=?, updated_at=? WHERE id=?')
      .run(preset, JSON.stringify(steps), String(note || ''), active ? 1 : 0, t, existing.id);
    forgeLog('studio:chain', `Kette [${clean}] aktualisiert (${steps.length} Stufen, aktiv=${active ? 1 : 0})`);
    return { id: existing.id, updated: true };
  }
  const res = db.prepare('INSERT INTO route_chains (name, preset, steps, active, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(clean, preset, JSON.stringify(steps), active ? 1 : 0, String(note || ''), t, t);
  forgeLog('studio:chain', `Kette [${clean}] angelegt (${steps.length} Stufen)`);
  return { id: Number(res.lastInsertRowid), created: true };
}

export function listChains() {
  return db.prepare('SELECT * FROM route_chains ORDER BY active DESC, updated_at DESC').all()
    .map((c) => ({ ...c, steps: JSON.parse(c.steps || '[]'), active: !!c.active }));
}

/** Protokolliert eine Simulation (fuer den Wochenbericht des Hunters). */
export function recordSimulation(chainId, sim) {
  db.prepare('INSERT INTO route_chain_runs (chain_id, simulated_at, steps, expected_ok, expected_lat_ms, detail) VALUES (?,?,?,?,?,?)')
    .run(chainId ? Number(chainId) : null, now(), Number(sim.steps || 0),
      Number(sim.expectedOkPercent || 0), Number(sim.expectedLatencyMs || 0),
      JSON.stringify(sim.plan || []).slice(0, 4000));
}

/**
 * Agenten-Auftrag: aus einem Freitext-Ziel eine Kette bauen.
 * Regelbasiert (ohne Modell), damit der Auftrag auch bei erschoepften Routen
 * sofort ein Ergebnis liefert - das LLM darf spaeter verfeinern.
 */
export function buildChainFromGoal(goal = '') {
  const g = String(goal).toLowerCase();
  const wantSpeed = /schnell|tempo|latenz|latency|fast/.test(g);
  const wantQuality = /beste|qualit|stark|elite|oss|120b|reason/.test(g);
  const limit = Number((g.match(/(\d{1,2})\s*(stufen|slots|routen)/) || [])[1] || 8);

  const ranking = eliteRanking({ limit: Math.max(3, Math.min(20, limit)) });
  let steps = ranking.map((r) => ({ routeId: r.id, role: 'primary' }));

  if (wantSpeed) {
    steps.sort((a, b) => {
      const ra = db.prepare('SELECT lat_ms FROM routes WHERE id = ?').get(a.routeId) || {};
      const rb = db.prepare('SELECT lat_ms FROM routes WHERE id = ?').get(b.routeId) || {};
      return (Number(ra.lat_ms) || 99999) - (Number(rb.lat_ms) || 99999);
    });
  }
  if (wantQuality) {
    // Qualitaetsnamen (OSS-120B, 70B, Pro) nach vorn, Rest bleibt als Fallback.
    steps.sort((a, b) => {
      const ra = String((db.prepare('SELECT model FROM routes WHERE id = ?').get(a.routeId) || {}).model || '');
      const rb = String((db.prepare('SELECT model FROM routes WHERE id = ?').get(b.routeId) || {}).model || '');
      const w = (m) => (/120b|70b|pro|large|27b/i.test(m) ? 2 : /8b|3b|small|lite|flash/i.test(m) ? 0 : 1);
      return w(rb) - w(ra);
    });
  }
  return {
    goal: String(goal || '').slice(0, 200),
    preset: wantSpeed ? 'speed' : wantQuality ? 'quality' : 'elite',
    steps,
    rationale: [
      wantSpeed ? 'Priorisiert gemessene Latenz.' : null,
      wantQuality ? 'Priorisiert starke Modellnamen als Erstwahl, Rest als Fallback.' : null,
      `Maximal 3 Slots je Provider, damit ein Provider-Ausfall die Kette nicht kippt.`,
    ].filter(Boolean),
  };
}

export function studioStatus() {
  const chains = listChains();
  const active = chains.filter((c) => c.active);
  return {
    elite: eliteRanking({ limit: 8 }),
    chains: chains.length,
    activeChains: active.map((c) => ({ id: c.id, name: c.name, preset: c.preset, steps: c.steps.length })),
    note: 'Elite-Paket und Ketten sind sichtbar und versioniert; Aktivierung aendert Prioritaeten/Routing nicht von selbst.',
  };
}
