// ============================================================================
// FREE ROUTE HUNTER — Ergaenzung zum bestehenden free-route-cycle.
//
// Arbeitsteilung:
//   free-route-cycle.mjs  Discovery der OpenRouter-:free-Modelle + Scan-Historie.
//   free-route-hunter.mjs (dieses Modul) erschliesst die Quellen, die der
//                         Zyklus NICHT kennt (lokale Ollama-Modelle, keyfreie
//                         Endpunkte), prueft die Gesundheit der registrierten
//                         Routen (429 -> Cooldown, 401/403 -> abschalten),
//                         misst Latenz und erzeugt den Wochenbericht.
//
// Schutzregeln: ausschliesslich kostenlose Routen, keine Keys im Code,
// keine Fremd-Endpunkte aus Nutzereingaben.
// ============================================================================
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db, now } from './db.mjs';
import { forgeLog } from './keyforge.mjs';
import { scanFreeRoutes } from './free-route-cycle.mjs';

// Optional-Spalten leise nachruesten: in frischen Installationen und in der
// Test-DB fehlen lat_ms/cooldown_until/dead, weil llm.mjs sie erst beim Import
// anlegt. Das Hunter-Modul muss unabhaengig davon funktionieren.
for (const ddl of [
  'ALTER TABLE routes ADD COLUMN dead INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE routes ADD COLUMN lat_ms INTEGER',
  'ALTER TABLE routes ADD COLUMN cooldown_until INTEGER NOT NULL DEFAULT 0'
]) {
  try { db.exec(ddl); } catch { /* Spalte existiert bereits */ }
}
db.exec(`CREATE TABLE IF NOT EXISTS hunter_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  discovered INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  probed INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT ''
)`);

const TIMEOUT_MS = 12_000;
export const OLLAMA_LOCAL_BASE = process.env.OLLAMA_LOCAL_BASE || 'http://127.0.0.1:11434';

/** Keyfreie Endpunkte (statisch gepflegt, bewusst konservativ). */
export const KEYLESS_CANDIDATES = [
  {
    name: 'Pollinations Text (kein Key)',
    provider: 'pollinations',
    baseUrl: 'https://text.pollinations.ai/openai',
    model: 'openai',
    keyEnv: '',
    priority: 20
  }
];

const norm = (s) => String(s || '').trim().toLowerCase();
const keyOf = (r) => `${norm(r.base_url || r.baseUrl)}|${norm(r.model)}`;

async function getJson(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Lokale Ollama-Modelle und keyfreie Endpunkte einsammeln (ohne Schreiben). */
export async function discoverLocalAndKeyless({ fetchImpl = fetch, includeLocal = true } = {}) {
  const candidates = [];
  const sources = [];

  if (includeLocal) {
    const tags = await getJson(`${OLLAMA_LOCAL_BASE}/api/tags`, { fetchImpl, timeoutMs: 6000 });
    if (tags.ok) {
      const models = (tags.data?.models || []).map((m) => String(m.name || '')).filter(Boolean);
      for (const model of models) {
        candidates.push({
          name: `Ollama lokal ${model} (kostenlos, offline)`,
          provider: 'ollama',
          baseUrl: `${OLLAMA_LOCAL_BASE}/v1`,
          model,
          keyEnv: '',
          priority: 30
        });
      }
      sources.push({ source: 'ollama:local', ok: true, count: models.length });
    } else {
      sources.push({ source: 'ollama:local', ok: false, count: 0, status: tags.status });
    }
  }

  candidates.push(...KEYLESS_CANDIDATES);
  sources.push({ source: 'no-key', ok: true, count: KEYLESS_CANDIDATES.length });

  const seen = new Set();
  const unique = candidates.filter((c) => {
    const k = keyOf(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { candidates: unique, sources };
}

/** Neue Kandidaten als Routen anlegen; nichts ueberschreiben, nur Gratis. */
export function integrate(candidates = []) {
  const existing = new Map();
  for (const r of db.prepare('SELECT id, name, base_url, model FROM routes').all()) existing.set(keyOf(r), r);
  const names = new Set(db.prepare('SELECT name FROM routes').all().map((r) => norm(r.name)));
  const insert = db.prepare(
    `INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used)
     VALUES (?,?,?,?,?,1,1,?,1,'NEW',0,0,0)`
  );
  const added = [];
  const skipped = [];
  for (const c of candidates) {
    if (c.isFree === false) { skipped.push({ name: String(c.name || '').trim() || '(ohne Namen)', reason: 'nicht kostenlos' }); continue; }
    if (existing.has(keyOf(c)) || names.has(norm(c.name))) { skipped.push({ name: c.name, reason: 'vorhanden' }); continue; }
    const name = String(c.name || '').trim();
    const baseUrl = String(c.baseUrl || '').trim();
    const model = String(c.model || '').trim();
    // Unvollstaendige Kandidaten ueberspringen, statt die Runde zu verlieren:
    // ein fehlendes model/baseUrl liess insert.run() vorher werfen (SQLite
    // "cannot be bound"), wodurch alle nachfolgenden Kandidaten verloren gingen.
    if (!name || !baseUrl || !model) {
      skipped.push({ name: name || '(ohne Namen)', reason: 'unvollstaendig' });
      continue;
    }
    const prio = Number(c.priority) || 30;
    try {
      insert.run(name, c.provider || 'openai-compatible', baseUrl, model, c.keyEnv || '', prio);
    } catch (e) {
      // Eine einzelne defekte Route darf die Discovery-Runde nie abbrechen.
      skipped.push({ name, reason: 'insert-fehler' });
      continue;
    }
    // Dublettenschutz gilt auch INNERHALB eines Laufs: den eben eingefuegten
    // Kandidaten sofort in die Pruefsets aufnehmen, sonst legt ein doppelter
    // Kandidat aus derselben Discovery-Liste zwei Routen an.
    existing.set(keyOf({ baseUrl, model }), { id: 0 });
    names.add(norm(name));
    added.push({ name, provider: c.provider, model, priority: prio });
    try { forgeLog('hunter:route', `Neue Gratis-Route [${c.name}] P${prio}`); } catch { /* Log ist optional */ }
  }
  return { added, skipped };
}

/** HTTP-Status eines Probelaufs in DB-Zustand uebersetzen. */
export function classifyProbe({ status = 0, ms = 0 } = {}) {
  if (status === 429) return { state: 'COOLDOWN', cooldownMs: 120_000, dead: 0, enabled: 1 };
  if (status === 401 || status === 403) return { state: 'DEAD', cooldownMs: 0, dead: 1, enabled: 0 };
  if (status >= 500) return { state: 'ERROR', cooldownMs: 30_000, dead: 0, enabled: 1 };
  if (status === 0) return { state: 'UNREACHABLE', cooldownMs: 30_000, dead: 0, enabled: 1 };
  return { state: 'OK', cooldownMs: 0, dead: 0, enabled: 1 };
}

/** Eine Route mit Mini-Prompt pruefen und Ergebnis in die DB schreiben. */
export async function probeRoute(route, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (route.key_env) {
    const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(route.key_env);
    const value = row?.value || process.env[route.key_env] || '';
    if (!value) return { id: route.id, name: route.name, state: 'NOKEY', ms: 0, status: 0 };
    headers.Authorization = `Bearer ${value}`;
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let status = 0;
  try {
    const res = await fetchImpl(`${String(route.base_url).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({ model: route.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
    });
    status = res.status;
    if (res.ok) await res.text().catch(() => '');
  } catch {
    status = 0;
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const cls = classifyProbe({ status, ms });
  const ok = cls.state === 'OK' ? 1 : 0;
  const ts = now();
  db.prepare(
    `UPDATE routes SET status = ?, ok = ok + ?, fail = fail + ?, lat_ms = ?, last_used = ?,
       cooldown_until = ?, dead = ?, enabled = ? WHERE id = ?`
  ).run(cls.state, ok, ok ? 0 : 1, ms, ts, cls.cooldownMs ? ts + cls.cooldownMs : 0, cls.dead, cls.enabled, route.id);
  return { id: route.id, name: route.name, state: cls.state, ms, status };
}

/** Die N am laengsten ungepruefte aktive Routen testen. */
export async function monitor({ limit = 6, fetchImpl = fetch } = {}) {
  const rows = db.prepare(
    "SELECT id, name, base_url, model, key_env FROM routes WHERE enabled = 1 AND provider != 'offline' ORDER BY COALESCE(last_used,0) ASC, id ASC LIMIT ?"
  ).all(Math.max(1, Number(limit) || 6));
  const out = [];
  for (const r of rows) out.push(await probeRoute(r, { fetchImpl }));
  return out;
}

/** Kompletter Zyklus: bestehende OpenRouter-Discovery + lokale/keyfreie Quellen + Probe. */
export async function hunterTick({ fetchImpl = fetch, fetchFn, monitorLimit = 6, includeLocal = true } = {}) {
  const cycle = await scanFreeRoutes({ fetchFn: fetchFn || fetchImpl }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  const local = await discoverLocalAndKeyless({ fetchImpl, includeLocal });
  const integration = integrate(local.candidates);
  const probes = await monitor({ limit: monitorLimit, fetchImpl });
  const ok = probes.filter((p) => p.state === 'OK').length;
  const dead = probes.filter((p) => p.state === 'DEAD').length;
  const ts = now();
  db.prepare('INSERT INTO hunter_runs (ts, discovered, added, probed, ok, dead, detail) VALUES (?,?,?,?,?,?,?)').run(
    ts,
    Number(cycle?.freeCount || 0) + local.candidates.length,
    Number(cycle?.discovered || 0) + integration.added.length,
    probes.length,
    ok,
    dead,
    JSON.stringify({ openrouter: cycle?.ok ? 'ok' : cycle?.error || 'fehler', sources: local.sources, skipped: integration.skipped.length })
  );
  return {
    ts,
    openrouter: { ok: Boolean(cycle?.ok), freeCount: Number(cycle?.freeCount || 0), discovered: Number(cycle?.discovered || 0) },
    local: { sources: local.sources, added: integration.added, skipped: integration.skipped.length },
    probes,
    ok,
    dead
  };
}

/** Zusatzbild zum bestehenden freeRouteCycleStatus (keine Doppelung). */
export function hunterStatus() {
  const rows = db.prepare('SELECT status, enabled, dead, is_free, provider, lat_ms, name, model, priority, ok, fail, id FROM routes').all();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const local = rows.filter((r) => r.provider === 'ollama');
  const keyless = rows.filter((r) => r.provider === 'pollinations');
  const top = rows
    .filter((r) => r.enabled === 1 && r.status === 'OK' && Number.isFinite(r.lat_ms) && r.lat_ms > 0)
    .sort((a, b) => a.lat_ms - b.lat_ms)
    .slice(0, 8)
    .map((r) => ({ id: r.id, name: r.name, provider: r.provider, lat_ms: r.lat_ms }));
  const failed = rows
    .filter((r) => r.dead === 1 || r.status === 'DEAD' || r.status === 'UNREACHABLE')
    .sort((a, b) => Number(b.fail) - Number(a.fail))
    .slice(0, 8)
    .map((r) => ({ id: r.id, name: r.name, provider: r.provider, status: r.status, fail: r.fail }));
  const runs = db.prepare('SELECT ts, discovered, added, probed, ok, dead FROM hunter_runs ORDER BY id DESC LIMIT 12').all();
  const weekAgo = now() - 7 * 86_400_000;
  const growth7d = db.prepare('SELECT COALESCE(SUM(added),0) n FROM hunter_runs WHERE ts > ?').get(weekAgo).n;
  return {
    routes: {
      total: rows.length,
      free: rows.filter((r) => r.is_free === 1).length,
      enabled: rows.filter((r) => r.enabled === 1).length,
      dead: rows.filter((r) => r.dead === 1).length,
      local: local.length,
      keyless: keyless.length
    },
    byStatus,
    top,
    failed,
    growth7d,
    runs,
    lastRun: runs[0] || null
  };
}

/** Wochenbericht als Markdown (Abgabekriterium der Villa). */
export function weeklyReport({ writeTo = '' } = {}) {
  const st = hunterStatus();
  const weekAgo = now() - 7 * 86_400_000;
  const recent = db.prepare('SELECT * FROM hunter_runs WHERE ts > ? ORDER BY id DESC LIMIT 60').all(weekAgo);
  const addedWeek = recent.reduce((a, r) => a + Number(r.added || 0), 0);
  const probedWeek = recent.reduce((a, r) => a + Number(r.probed || 0), 0);
  const deadWeek = recent.reduce((a, r) => a + Number(r.dead || 0), 0);
  const lines = [
    '# Free Route Hunter — Wochenbericht',
    '',
    `Erstellt: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    '## Netzwerk',
    '',
    `- Routen gesamt: **${st.routes.total}** (kostenlos: ${st.routes.free}, aktiv: ${st.routes.enabled}, tot: ${st.routes.dead})`,
    `- Lokale Ollama-Routen: ${st.routes.local}, keyfreie Routen: ${st.routes.keyless}`,
    `- Neue Routen in 7 Tagen: **${addedWeek}**`,
    `- Probelaeufe in 7 Tagen: ${probedWeek}, als tot abgeschaltet: ${deadWeek}`,
    '',
    '## Schnellste aktive Routen',
    '',
    '| Route | Provider | Latenz |',
    '|---|---|---|',
    ...st.top.map((r) => `| ${r.name} | ${r.provider} | ${r.lat_ms} ms |`),
    '',
    '## Auffaellige Routen',
    '',
    ...(st.failed.length ? st.failed.map((r) => `- ${r.name} (${r.provider}): ${r.status}, ${r.fail} Fehler`) : ['- keine']),
    '',
    '## Letzte Zyklen',
    '',
    '| Zeit | entdeckt | integriert | geprueft | ok | tot |',
    '|---|---|---|---|---|---|',
    ...st.runs.map((r) => `| ${new Date(r.ts).toISOString().slice(5, 16).replace('T', ' ')} | ${r.discovered} | ${r.added} | ${r.probed} | ${r.ok} | ${r.dead} |`),
    '',
    '_Der Hunter integriert ausschliesslich Routen mit Preis 0 und keine bezahlten Endpunkte._',
    ''
  ];
  const markdown = lines.join('\n');
  if (writeTo) {
    try {
      const file = resolve(writeTo);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, markdown);
    } catch { /* Bericht bleibt gueltig, auch wenn die Ablage scheitert */ }
  }
  return { markdown, stats: { addedWeek, probedWeek, deadWeek, ...st.routes } };
}

/** Ablageort: Villa-Workspace, falls vorhanden. */
export function reportPath(dir = process.env.FREE_ROUTE_REPORT_DIR || '/opt/villaforge/workspace/free-route-hunter/reports') {
  if (!dir || !existsSync(dir)) return '';
  return resolve(dir, `wochenbericht-${new Date().toISOString().slice(0, 10)}.md`);
}
