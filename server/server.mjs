import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { db, now } from './db.mjs';
import { FREE_ROUTE_CATALOG } from './routes.mjs';
import { chat, enabledRoutes, resolveKey, keyStatus } from './llm.mjs';
import { createVilla, runAgent, orchestrate, stopVilla, isRunning, TOOL_SPECS, memoryContext, setSource, analyzeProject } from './agents.mjs';
import { bus } from './events.mjs';

const PORT = Number(process.env.PORT || 12000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = resolve(process.cwd(), 'server/public');

/* --------------------------- Seed --------------------------- */
if (db.prepare('SELECT COUNT(*) c FROM routes').get().c === 0) {
  const ins = db.prepare(
    'INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (const r of FREE_ROUTE_CATALOG) {
    ins.run(r.name, r.provider, r.baseUrl, r.model, r.keyEnv, 1, 1, r.priority, 1, 'NEW', 0, 0, 0);
  }
  console.log('[villaforge] Routen-Katalog initialisiert:', FREE_ROUTE_CATALOG.length);
}

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
      try { resolveP(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = join(PUBLIC_DIR, rel.replace(/\.\./g, ''));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Nicht gefunden');
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(file));
}

/* --------------------------- API --------------------------- */
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const parts = p.split('/').filter(Boolean); // ['api', ...]

  if (p === '/api/health') {
    return json(res, 200, { ok: true, ts: now(), routes: enabledRoutes().length, version: '1.0.0' });
  }

  // ---- Routen ----
  if (p === '/api/routes' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM routes ORDER BY priority ASC, id ASC').all();
    return json(res, 200, rows.map((r) => ({ ...r, hasKey: r.provider === 'offline' || !!resolveKey(r.key_env) })));
  }
  if (p === '/api/routes' && m === 'POST') {
    const b = await readBody(req);
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
    if (!b.name) return json(res, 400, { error: 'name fehlt' });
    db.prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(String(b.name), String(b.value || ''), now());
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
    return json(res, 200, db.prepare('SELECT * FROM villas ORDER BY created_at DESC').all());
  }
  if (p === '/api/villas' && m === 'POST') {
    const b = await readBody(req);
    if (!b.idea) return json(res, 400, { error: 'idea fehlt' });
    const result = await createVilla({
      name: b.name || 'Villa',
      idea: b.idea,
      agentCount: b.agentCount,
      sourcePath: b.sourcePath || '',
      mode: b.sourcePath ? (b.mode || 'ANALYZE') : 'BUILD'
    });
    return json(res, 201, result);
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts.length === 3 && m === 'GET') {
    const id = Number(parts[2]);
    const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(id);
    if (!villa) return json(res, 404, { error: 'Villa nicht gefunden' });
    return json(res, 200, {
      villa,
      agents: db.prepare('SELECT * FROM agents WHERE villa_id = ? ORDER BY is_root DESC, id ASC').all(id),
      tasks: db.prepare('SELECT * FROM tasks WHERE villa_id = ? ORDER BY priority ASC, id ASC').all(id),
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
    orchestrate(id, {
      concurrency: Number(b.concurrency) || 4,
      maxTasks: Number(b.maxTasks) || 500,
      adaptive: b.adaptive !== false
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
      ? db.prepare('SELECT * FROM messages WHERE villa_id = ? AND agent_id = ? ORDER BY id ASC').all(id, agentId)
      : db.prepare('SELECT * FROM messages WHERE villa_id = ? ORDER BY id DESC LIMIT 200').all(id);
    return json(res, 200, rows);
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'chat' && m === 'POST') {
    const id = Number(parts[2]);
    const b = await readBody(req);
    const agent = b.agentId
      ? db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(b.agentId))
      : db.prepare('SELECT * FROM agents WHERE villa_id = ? AND is_root = 1').get(id);
    if (!agent) return json(res, 404, { error: 'Agent nicht gefunden' });
    db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, created_at) VALUES (?,?,?,?,?)').run(id, agent.id, 'user', String(b.message || ''), now());
    const res2 = await runAgent(agent, String(b.message || ''), { maxSteps: 6, villaId: id });
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
    api(req, res, url).catch((err) => json(res, 500, { error: String(err.message || err) }));
  } else {
    serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[villaforge] Hub laeuft auf http://${HOST}:${PORT}`);
  console.log(`[villaforge] UI:      http://localhost:${PORT}/`);
  console.log(`[villaforge] Health:  http://localhost:${PORT}/api/health`);
});
