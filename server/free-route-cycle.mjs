import { db, now } from './db.mjs';
import { FREE_ROUTE_CATALOG } from './routes.mjs';
import { isFreeRoute } from './llm-config.mjs';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,159}$/;
const MAX_MODELS_PER_SCAN = 500;

db.exec(`CREATE TABLE IF NOT EXISTS free_route_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  discovered INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS free_route_discoveries (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_free_route_scans_time ON free_route_scans(scanned_at);`);

function freeOpenRouterModel(model) {
  const id = String(model?.id || '').trim();
  const pricing = model?.pricing || {};
  const input = Number(pricing.prompt), output = Number(pricing.completion);
  return MODEL_ID.test(id) && !/^https?:\/\//i.test(id) && !/[?#]/.test(id) && id.toLowerCase().endsWith(':free')
    && Number.isFinite(input) && Number.isFinite(output) && input === 0 && output === 0;
}

function routeExists(modelId) {
  return !!db.prepare('SELECT id FROM routes WHERE provider=? AND base_url=? AND model=?').get('openrouter', 'https://openrouter.ai/api/v1', modelId);
}

function addRoute(model, timestamp) {
  const id = String(model.id).trim();
  const title = `OpenRouter ${id} (free)`;
  if (routeExists(id)) {
    db.prepare(`UPDATE routes SET enabled=1,status='DISCOVERED'
      WHERE provider='openrouter' AND base_url='https://openrouter.ai/api/v1' AND model=? AND status='STALE_FREE_CATALOG'`).run(id);
  } else {
    db.prepare(`INSERT INTO routes(name,provider,base_url,model,key_env,is_free,enabled,priority,weight,status,ok,fail,last_used)
      VALUES(?,?,?,?,?,1,1,24,1,'DISCOVERED',0,0,0)`)
      .run(title.slice(0, 160), 'openrouter', 'https://openrouter.ai/api/v1', id, 'OPENROUTER_API_KEY');
  }
  db.prepare(`INSERT INTO free_route_discoveries(model_id,provider,first_seen,last_seen,active)
    VALUES(?, 'openrouter', ?, ?, 1)
    ON CONFLICT(model_id) DO UPDATE SET last_seen=excluded.last_seen, active=1`).run(id, timestamp, timestamp);
}

/**
 * Discovers only models whose official catalog explicitly reports $0 input and
 * output pricing and a :free model variant. It never creates accounts, keys,
 * paid routes, or routes from arbitrary user-supplied endpoints.
 */
export async function scanFreeRoutes({ fetchFn = fetch, clock = now } = {}) {
  const timestamp = clock();
  try {
    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      headers: { accept: 'application/json', 'user-agent': 'VillaForge-FreeRouteCycle/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`OpenRouter models HTTP ${response.status}`);
    const body = await response.json();
    const models = Array.isArray(body?.data) ? body.data.slice(0, MAX_MODELS_PER_SCAN) : [];
    const freeModels = models.filter(freeOpenRouterModel);
    const before = new Set(db.prepare("SELECT model_id FROM free_route_discoveries WHERE provider='openrouter'").all().map((row) => row.model_id));
    const addable = freeModels.slice(0, 100);
    for (const model of addable) addRoute(model, timestamp);
    const seen = new Set(addable.map((model) => String(model.id)));
    db.prepare("UPDATE free_route_discoveries SET active=0 WHERE provider='openrouter'").run();
    for (const id of seen) db.prepare("UPDATE free_route_discoveries SET active=1,last_seen=? WHERE model_id=? AND provider='openrouter'").run(timestamp, id);
    db.prepare(`UPDATE routes SET enabled=0,status='STALE_FREE_CATALOG'
      WHERE provider='openrouter' AND model IN (
        SELECT model_id FROM free_route_discoveries WHERE provider='openrouter' AND active=0
      )`).run();
    const discovered = addable.filter((model) => !before.has(String(model.id))).length;
    db.prepare('INSERT INTO free_route_scans(scanned_at,provider,discovered,status,detail) VALUES(?,?,?,?,?)')
      .run(timestamp, 'openrouter', discovered, 'OK', `${freeModels.length} explicitly zero-priced free model(s) found`);
    return { ok: true, provider: 'openrouter', scannedAt: timestamp, catalogCount: models.length, freeCount: freeModels.length, discovered };
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 240);
    db.prepare('INSERT INTO free_route_scans(scanned_at,provider,discovered,status,detail) VALUES(?,?,?,?,?)')
      .run(timestamp, 'openrouter', 0, 'ERROR', detail);
    return { ok: false, provider: 'openrouter', scannedAt: timestamp, discovered: 0, error: detail };
  }
}

export function freeRouteCycleStatus() {
  const routes = db.prepare('SELECT id,name,provider,base_url,model,key_env,is_free,enabled,priority,status,ok,fail,cooldown_until FROM routes ORDER BY priority,id').all();
  const freeRoutes = routes.filter((route) => isFreeRoute(route));
  const latest = db.prepare('SELECT scanned_at AS scannedAt,provider,discovered,status,detail FROM free_route_scans ORDER BY id DESC LIMIT 1').get() || null;
  const discoveries = db.prepare("SELECT model_id AS modelId,first_seen AS firstSeen,last_seen AS lastSeen,active FROM free_route_discoveries WHERE provider='openrouter' ORDER BY active DESC,last_seen DESC LIMIT 500").all();
  const configuredKeys = new Set(db.prepare('SELECT name FROM secrets').all().map((row) => row.name));
  const available = freeRoutes.filter((route) => route.enabled && (!route.key_env || process.env[route.key_env] || configuredKeys.has(route.key_env)) && Number(route.cooldown_until || 0) <= now());
  return {
    mode: 'FREE_ONLY',
    guarantees: { paidRoutesExcludedByDefault: true, accountsOrKeysCreatedAutomatically: false, quotaOrUptimeGuaranteed: false },
    summary: { catalogFree: FREE_ROUTE_CATALOG.filter((route) => isFreeRoute({ provider: route.provider, base_url: route.baseUrl, model: route.model })).length, configuredFree: freeRoutes.length, currentlyAvailable: available.length, discoveredModels: discoveries.length, activeDiscovered: discoveries.filter((row) => row.active).length },
    latestScan: latest,
    routes: freeRoutes.map((route) => ({ id: route.id, name: route.name, provider: route.provider, model: route.model, enabled: !!route.enabled, available: available.some((item) => item.id === route.id), priority: route.priority, status: route.status, successes: route.ok, failures: route.fail, cooldownUntil: route.cooldown_until || 0 })),
    discoveries
  };
}

export function freeRouteScanHistory(limit = 20) {
  return db.prepare('SELECT scanned_at AS scannedAt,provider,discovered,status,detail FROM free_route_scans ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(limit) || 20)));
}
