import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { db, now } from './db.mjs';
import { seedRoutes, syncCatalog } from './seed.mjs';
import { validateRoute, validateSecret, validateVilla, validateMessage, validateOrchestrate } from './validate.mjs';
import { chat, enabledRoutes, resolveKey, keyStatus } from './llm.mjs';
import { createVilla, runAgent, orchestrate, stopVilla, isRunning, TOOL_SPECS, memoryContext, setSource, analyzeProject } from './agents.mjs';
import { resumePendingVillas } from './resume.mjs';
import { bus } from './events.mjs';

const PORT = Number(process.env.PORT || 12000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = resolve(process.cwd(), 'server/public');
// Optionaler Bearer-Token: gesetzt via VF_TOKEN, aktiviert den Schutz
// aller API-Endpunkte (Health bleibt offen, damit Ueberwachung klappt).
const API_TOKEN = process.env.VF_TOKEN || '';

/* --------------------------- Protokoll --------------------------- */
// Ausgabe auf stdout/stderr. Im Daemon-Betrieb (scripts/daemon.sh) wird die
// Ausgabe in server/data/hub.log umgeleitet, damit sie einheitlich an einer
// Stelle landet und nicht doppelt geschrieben wird.
const log = (...a) => console.log(new Date().toISOString(), '[villaforge]', ...a);
const logError = (...a) => console.error(new Date().toISOString(), '[villaforge]', ...a);

/* --------------------------- Seed --------------------------- */
seedRoutes();
const updatedRoutes = syncCatalog();
if (updatedRoutes) console.log(`[villaforge] ${updatedRoutes} Route(n) auf aktuellen Katalogstand gebracht.`);

/* --------------------------- Helpers --------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveP, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolveP({});
      try { resolveP(JSON.parse(raw)); } catch (e) { reject(Object.assign(e, { statusCode: 400, public: 'Body ist kein gueltiges JSON' })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  // Pfad dekodieren und normalisieren, bevor die Prefix-Pruefung laeuft.
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Ungueltiger Pfad');
  }
  if (rel.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Nicht gefunden');
  }
  const file = resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + '/') || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Nicht gefunden');
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(file));
}

/* --------------------------- API --------------------------- */
/* ---------- Rate-Limit fuer schreibende Anfragen ---------- */
// Ein einfaches prozesslocales Zeitfenster pro IP. GET bleibt frei, SSE sowieso.
// VF_RATE_LIMIT=0 schaltet ab. Der Hub laeuft einzeln, daher reicht ein Map-Store.
const RATE_LIMIT = Number(process.env.VF_RATE_LIMIT ?? 120);
const rateHits = new Map();
function rateAllow(ip) {
  if (RATE_LIMIT <= 0) return true;
  const nowMs = Date.now();
  const recent = (rateHits.get(ip) || []).filter((t) => nowMs - t < 60_000);
  if (recent.length >= RATE_LIMIT) {
    rateHits.set(ip, recent);
    return false;
  }
  recent.push(nowMs);
  rateHits.set(ip, recent);
  if (rateHits.size > 10_000) rateHits.clear(); // Grobdeckel gegen IP-Flooding
  return true;
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const parts = p.split('/').filter(Boolean); // ['api', ...]

  // Schreibende Anfragen rate-limitieren: ein Klient soll den Hub nicht mit
  // Anlagen oder Laeufen fluten koennen. GET und SSE bleiben unberuehrt.
  if (m !== 'GET' && p !== '/api/events' && !rateAllow(req.socket.remoteAddress || '?')) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Zu viele Anfragen — kurz durchatmen, dann gern wieder.' }));
    return;
  }

  // Schutz: gilt nur, wenn VF_TOKEN gesetzt ist; Health bleibt offen.
  // EventSource (SSE) kann keine Header senden — deshalb ist neben dem
  // Bearer-Header auch ?token= erlaubt, ausnahmsweise auch im Log unsichtbar.
  if (API_TOKEN && p !== '/api/health') {
    const header = (req.headers.authorization || '') === `Bearer ${API_TOKEN}`;
    const query = url.searchParams.get('token') === API_TOKEN;
    if (!header && !query) {
      return json(res, 401, { error: 'Nicht autorisiert: Bearer-Token fehlt oder ist falsch' });
    }
  }

  if (p === '/api/health') {
    return json(res, 200, { ok: true, ts: now(), routes: enabledRoutes().length, version: '1.3.0' });
  }

  // ---- Routen ----
  if (p === '/api/routes' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM routes ORDER BY priority ASC, id ASC').all();
    return json(res, 200, rows.map((r) => ({ ...r, hasKey: r.provider === 'offline' || !!resolveKey(r.key_env) })));
  }
  if (p === '/api/routes' && m === 'POST') {
    const b = await readBody(req);
    const v = validateRoute(b);
    if (!v.ok) return json(res, 400, { error: v.error });
    const { name, baseUrl, model, keyEnv, priority } = v.value;
    const id = db.prepare(
      'INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(b.name || 'Route', b.provider || 'openai-compatible', b.baseUrl || '', b.model || '', b.keyEnv || '', b.isFree ? 1 : 0, 1, Number(b.priority) || 10, 1, 'NEW', 0, 0, 0).lastInsertRowid;
    return json(res, 201, { id });
  }
  if (parts[0] === 'api' && parts[1] === 'routes' && parts[2] && m === 'PATCH') {
    const b = await readBody(req);
    if (typeof b.enabled === 'boolean') db.prepare('UPDATE routes SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, Number(parts[2]));
    if (b.priority != null) db.prepare('UPDATE routes SET priority = ? WHERE id = ?').run(Number(b.priority), Number(parts[2]));
    return json(res, 200, { ok: true });
  }
  if (parts[0] === 'api' && parts[1] === 'routes' && parts[2] && m === 'DELETE') {
    db.prepare('DELETE FROM routes WHERE id = ?').run(Number(parts[2]));
    return json(res, 200, { ok: true });
  }

  // ---- Secrets (nur Namen, niemals Werte) ----
  if (p === '/api/secrets' && m === 'GET') {
    return json(res, 200, db.prepare('SELECT name, updated_at FROM secrets').all());
  }
  if (p === '/api/secrets' && m === 'POST') {
    const b = await readBody(req);
    const v = validateSecret(b);
    if (!v.ok) return json(res, 400, { error: v.error });
    db.prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(v.value.name, v.value.value, now());
    return json(res, 200, { ok: true });
  }
  if (parts[0] === 'api' && parts[1] === 'secrets' && parts[2] && m === 'DELETE') {
    db.prepare('DELETE FROM secrets WHERE name = ?').run(parts[2]);
    return json(res, 200, { ok: true });
  }

  // ---- Tools ----
  if (p === '/api/tools' && m === 'GET') return json(res, 200, TOOL_SPECS);

  // ---- Villas ----
  if (p === '/api/villas' && m === 'GET') {
    // Deckel und Paginierung: ungebundene Listen waechsen unbrauchbar.
    // Die Antwort bleibt ein Array (App und Web-UI parsen genau das);
    // Gesamtzahl steht im X-Total-Count-Header, blaettern via ?limit=/?offset=.
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const rows = db.prepare('SELECT * FROM villas ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) c FROM villas').get().c;
    const body = JSON.stringify(rows);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Total-Count': String(total),
      'X-Limit': String(limit),
      'X-Offset': String(offset)
    });
    res.end(body);
    return;
  }
  if (p === '/api/villas' && m === 'POST') {
    const b = await readBody(req);
    const v = validateVilla(b);
    if (!v.ok) return json(res, 400, { error: v.error });
    const result = await createVilla(v.value);
    return json(res, 201, result);
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts.length === 3 && m === 'GET') {
    const id = Number(parts[2]);
    const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(id);
    if (!villa) return json(res, 404, { error: 'Villa nicht gefunden' });
    return json(res, 200, {
      villa,
      agents: db.prepare('SELECT * FROM agents WHERE villa_id = ? ORDER BY is_root DESC, id ASC LIMIT 500').all(id),
      tasks: db.prepare('SELECT * FROM tasks WHERE villa_id = ? ORDER BY priority ASC, id ASC LIMIT 500').all(id),
      memories: db.prepare('SELECT * FROM memories WHERE villa_id = ? ORDER BY importance DESC, id DESC LIMIT 200').all(id),
      reports: db.prepare('SELECT id, villa_id, kind, title, content, created_at FROM reports WHERE villa_id = ? ORDER BY id DESC LIMIT 50').all(id),
      audit: db.prepare('SELECT * FROM audit WHERE villa_id = ? ORDER BY id DESC LIMIT 200').all(id),
      running: isRunning(id)
    });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'source' && m === 'POST') {
    const id = Number(parts[2]);
    const b = await readBody(req);
    if (!b.path) return json(res, 400, { error: 'path fehlt' });
    const abs = setSource(id, b.path);
    const exists = existsSync(abs);
    return json(res, 200, { ok: true, path: abs, exists });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'analyze' && m === 'POST') {
    const id = Number(parts[2]);
    const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(id);
    if (!villa) return json(res, 404, { error: 'Villa nicht gefunden' });
    const root = db.prepare('SELECT * FROM agents WHERE villa_id = ? AND is_root = 1').get(id);
    analyzeProject(id, root?.id).catch(() => {});
    return json(res, 202, { ok: true, started: true });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'reports' && m === 'GET') {
    const id = Number(parts[2]);
    return json(res, 200, db.prepare('SELECT * FROM reports WHERE villa_id = ? ORDER BY id DESC LIMIT 100').all(id));
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'orchestrate' && m === 'POST') {
    const id = Number(parts[2]);
    const b = await readBody(req).catch(() => ({}));
    if (isRunning(id)) return json(res, 202, { ok: true, alreadyRunning: true });
    const check = validateOrchestrate(b);
    if (!check.ok) return json(res, 400, { error: check.error });
    orchestrate(id, {
      concurrency: check.value.concurrency ?? 4,
      maxTasks: check.value.maxTasks ?? 500,
      adaptive: check.value.adaptive ?? true,
      maxRounds: check.value.maxRounds ?? 6
    }).catch(() => {});
    return json(res, 202, { ok: true, started: true });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'stop' && m === 'POST') {
    const id = Number(parts[2]);
    const stopped = stopVilla(id);
    return json(res, 200, { ok: true, stopped });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'messages' && m === 'GET') {
    const id = Number(parts[2]);
    const agentId = Number(url.searchParams.get('agentId') || 0);
    const rows = agentId
      ? db.prepare('SELECT * FROM (SELECT * FROM messages WHERE villa_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id ASC').all(id, agentId)
      : db.prepare('SELECT * FROM messages WHERE villa_id = ? ORDER BY id DESC LIMIT 200').all(id);
    return json(res, 200, rows);
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'chat' && m === 'POST') {
    const id = Number(parts[2]);
    const b = await readBody(req);
    const vm = validateMessage(b);
    if (!vm.ok) return json(res, 400, { error: vm.error });
    const agent = b.agentId
      ? db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(b.agentId))
      : db.prepare('SELECT * FROM agents WHERE villa_id = ? AND is_root = 1').get(id);
    if (!agent) return json(res, 404, { error: 'Agent nicht gefunden' });
    db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, created_at) VALUES (?,?,?,?,?)').run(id, agent.id, 'user', vm.value.message, now());
    const res2 = await runAgent(agent, vm.value.message, { maxSteps: 6, villaId: id });
    const answer = res2.answer || res2.error || 'Keine Antwort.';
    db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, created_at) VALUES (?,?,?,?,?)').run(id, agent.id, 'assistant', answer, now());
    return json(res, 200, { agentId: agent.id, answer, route: res2.route, model: res2.model, trace: res2.trace, offline: res2.offline });
  }

  // ---- Direktchat mit einem Agenten (ohne Villa) ----
  if (parts[0] === 'api' && parts[1] === 'agents' && parts[2] && parts[3] === 'chat' && m === 'POST') {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(parts[2]));
    if (!agent) return json(res, 404, { error: 'Agent nicht gefunden' });
    const b = await readBody(req);
    const r = await runAgent(agent, String(b.message || ''), { maxSteps: 6, villaId: agent.villa_id });
    return json(res, 200, r);
  }

  // ---- SSE ----
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('retry: 3000\n\n');
    const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    bus.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
    return;
  }

  return json(res, 404, { error: 'Unbekannter Endpunkt', path: p });
}

/* --------------------------- Server --------------------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((err) => {
      const code = err.statusCode || 500;
      const message = err.public || 'Interner Fehler';
      if (code >= 500) logError('API-Fehler', url.pathname, String(err.message || err));
      json(res, code, { error: message });
    });
  } else {
    serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, HOST, () => {
  log(`Hub laeuft auf http://${HOST}:${PORT}`);
  log(`UI:      http://localhost:${PORT}/`);
  log(`Health:  http://localhost:${PORT}/api/health`);
  if (API_TOKEN) log('API-Schutz aktiv (VF_TOKEN gesetzt).');

  // Nach einem Neustart unterbrochene Laeufe fortsetzen (nur wenn erlaubt).
  if (process.env.VF_RESUME !== '0') {
    try { resumePendingVillas(); } catch (err) { logError('Wiederaufnahme fehlgeschlagen:', err.message || err); }
  }
});

/* --------------------------- Daemon-Betrieb --------------------------- */
// Ein Fehler in einem einzelnen Aufruf darf den Daemon nicht beenden.
process.on('unhandledRejection', (err) => logError('Unbehandelte Ablehnung:', err?.message || err));
process.on('uncaughtException', (err) => logError('Unbehandelte Ausnahme:', err?.message || err));

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} empfangen, fahre herunter ...`);
    server.close(() => {
      log('Server geschlossen.');
      process.exit(0);
    });
    // Notbremse, falls Verbindungen nicht schliessen.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
