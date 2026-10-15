import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import util from 'node:util';
import { extname, join, resolve } from 'node:path';
import { db, now } from './db.mjs';
import { seedRoutes, syncCatalog } from './seed.mjs';
import { validateRoute, validateSecret, validateVilla, validateVillaPatch, validateTaskPatch, TASK_STATUSES, validateMessage, validateOrchestrate } from './validate.mjs';
import { chat, enabledRoutes, resolveKey, keyStatus, keyPools, llmGateStatus } from './llm.mjs';
import { cmdGateStatus, projectSummary, projectTree, searchProject, readProjectFile, runCommand, ALLOWED } from './fs-tools.mjs';
import { schedulerStatus, villaRanking, configureScheduler, enqueueVillas } from './scheduler.mjs';
import { createVilla, runAgent, orchestrate, stopVilla, isRunning, listRunning, toolSpecs, memoryContext, setSource, analyzeProject, importVilla, sourceRoot } from './agents.mjs';
import { resumePendingVillas } from './resume.mjs';
import { bus, emit, eventsSince } from './events.mjs';
import { pruneOldData, autoResumeQuotaVillas } from './maintenance.mjs';
import { runCouncil, listCouncil, autoCouncil } from './council.mjs';
import { packState, packSummary, setPackEnabled, packEnabled } from './packs.mjs';
import { VERSION } from './version.mjs';
import { createMasterControl } from './master-control.mjs';

const PORT = Number(process.env.PORT || 12000);
const HOST = process.env.HOST || '0.0.0.0';

const PUBLIC_DIR = resolve(process.cwd(), 'server/public');
// Optionaler Bearer-Token: gesetzt via VF_TOKEN, aktiviert den Schutz
// aller API-Endpunkte (Health bleibt offen, damit Ueberwachung klappt).
const API_TOKEN = process.env.VF_TOKEN || '';

/* ------------------- Konfigurations-Check ------------------- */
// Frueher, laut und mit klarer Fehlermeldung abbrechen statt mit
// kaputter Konfiguration halb lauffaehig zu starten.
function checkConfig() {
  const errors = [];
  if (process.env.PORT != null && (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)) {
    errors.push(`PORT muss zwischen 1 und 65535 liegen (ist: ${JSON.stringify(process.env.PORT)})`);
  }
  if (HOST && !/^[a-zA-Z0-9.:[\]-]+$/.test(HOST)) {
    errors.push(`HOST sieht nicht nach Hostname/IP aus (ist: ${JSON.stringify(HOST)})`);
  }
  if (process.env.VF_RATE_LIMIT != null) {
    const rl = Number(process.env.VF_RATE_LIMIT);
    if (!Number.isInteger(rl) || rl < 0) {
      errors.push(`VF_RATE_LIMIT muss 0 oder eine positive Ganzzahl sein (ist: ${JSON.stringify(process.env.VF_RATE_LIMIT)})`);
    }
  }
  if (errors.length) {
    for (const e of errors) console.error('[villaforge] Konfiguration ungueltig:', e);
    process.exit(1);
  }
}
checkConfig();
if (process.argv.includes('--check')) {
  console.log(`[villaforge] Konfiguration ok: Port ${PORT}, Host ${HOST}, Rate-Limit ${process.env.VF_RATE_LIMIT ?? 120}/min, Token-Schutz ${API_TOKEN ? 'an' : 'aus'}`);
  process.exit(0);
}

/* --------------------------- Protokoll --------------------------- */
// Ausgabe auf stdout/stderr. Im Daemon-Betrieb (scripts/daemon.sh) wird die
// Ausgabe in server/data/hub.log umgeleitet, damit sie einheitlich an einer
// Stelle landet und nicht doppelt geschrieben wird. Wer die Meldungen
// zusaetzlich dauerhaft in einer Datei braucht, setzt VF_LOG_FILE: dann wird
// jede Zeile synchron (reihenfolgestabil, auch beim Absturz) angehaengt.
const LOG_FILE = String(process.env.VF_LOG_FILE || '').trim();
let logFd = null;
if (LOG_FILE) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    logFd = openSync(LOG_FILE, 'a');
  } catch (e) {
    console.error('[villaforge] VF_LOG_FILE nicht beschreibbar, nur Konsole:', e.message);
  }
}
const writeLog = (stream, level, args) => {
  const line = `${new Date().toISOString()} [villaforge] ${level} ${util.format(...args)}\n`;
  stream.write(line);
  if (logFd != null) {
    try { writeSync(logFd, line); } catch { /* volles Laufwerk o. ae. darf den Hub nicht beenden */ }
  }
};
const log = (...a) => writeLog(process.stdout, 'INFO', a);
const logError = (...a) => writeLog(process.stderr, 'ERROR', a);

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
  // ETag aus Groesse und Aenderungszeit: klientenseitiges Caching per
  // If-None-Match, 304 spart Transfer und Laufzeit.
  const stat = statSync(file);
  const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': type, ETag: etag });
  res.end(readFileSync(file));
}

const scheduledOptions = new Map();
function scheduleVilla(id, options = {}) {
  scheduledOptions.set(id, options);
  return enqueueVillas([id]);
}
configureScheduler({ start: id => {
  const options = scheduledOptions.get(id) || { concurrency:4,maxTasks:500,adaptive:true,maxRounds:6 };
  scheduledOptions.delete(id);
  return orchestrate(id,options);
} });
const masterControl = createMasterControl({ chat, createVilla, isRunning, stopVilla, toolSpecs, packState, setPackEnabled, emit, startVilla(id) { return scheduleVilla(id); } });

/* --------------------------- API --------------------------- */
/* ---------- Rate-Limit fuer schreibende Anfragen ---------- */
// Ein einfaches prozesslocales Zeitfenster pro IP. GET bleibt frei, SSE sowieso.
// VF_RATE_LIMIT=0 schaltet ab. Der Hub laeuft einzeln, daher reicht ein Map-Store.
const RATE_LIMIT = Number(process.env.VF_RATE_LIMIT ?? 120);
const rateHits = new Map();
function rateAllow(ip) {
  if (RATE_LIMIT <= 0) return { ok: true, limit: 0, remaining: -1, reset: 0 };
  const nowMs = Date.now();
  const recent = (rateHits.get(ip) || []).filter((t) => nowMs - t < 60_000);
  const reset = Math.max(1, Math.ceil(((recent[0] ?? nowMs) + 60_000 - nowMs) / 1000));
  if (recent.length >= RATE_LIMIT) {
    rateHits.set(ip, recent);
    return { ok: false, limit: RATE_LIMIT, remaining: 0, reset };
  }
  recent.push(nowMs);
  rateHits.set(ip, recent);
  if (rateHits.size > 10_000) rateHits.clear(); // Grobdeckel gegen IP-Flooding
  return { ok: true, limit: RATE_LIMIT, remaining: RATE_LIMIT - recent.length, reset };
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const parts = p.split('/').filter(Boolean); // ['api', ...]

  // Schreibende Anfragen rate-limitieren: ein Klient soll den Hub nicht mit
  // Anlagen oder Laeufen fluten koennen. GET und SSE bleiben unberuehrt.
  if (m !== 'GET' && p !== '/api/events') {
    const rate = rateAllow(req.socket.remoteAddress || '?');
    if (!rate.ok) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(rate.reset),
        'X-RateLimit-Limit': String(rate.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(rate.reset),
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'Zu viele Anfragen — kurz durchatmen, dann gern wieder.' }));
      return;
    }
    if (rate.limit > 0) {
      res.setHeader('X-RateLimit-Limit', String(rate.limit));
      res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
      res.setHeader('X-RateLimit-Reset', String(rate.reset));
    }
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

  if (await masterControl.handle(req, res, url, readBody, json)) return;

  if (p === '/api/health') {
    return json(res, 200, { ok: true, masterControl: 1, ts: now(), routes: enabledRoutes().length, version: VERSION, llm: llmGateStatus(), cmd: cmdGateStatus(), scheduler: { slots: schedulerStatus().slots, active: schedulerStatus().active.length, queued: schedulerStatus().queued } });
  }

  // ---- Routen ----
  // Kompletter Dump aller Villen als Backup: Elemente des villas-Arrays sind
  // direkt per POST /api/villas/import wiederherstellbar.
  if (p === '/api/backup' && m === 'GET') {
    const pick = (table, villaId, limit) =>
      db.prepare(`SELECT * FROM ${table} WHERE villa_id = ? ORDER BY id DESC LIMIT ?`).all(villaId, limit);
    const rows = db.prepare('SELECT * FROM villas ORDER BY id ASC').all();
    const villas = rows.map((villa) => ({
      villa,
      agents: pick('agents', villa.id, 500),
      tasks: pick('tasks', villa.id, 2000),
      memories: pick('memories', villa.id, 500),
      reports: pick('reports', villa.id, 100),
      messages: pick('messages', villa.id, 1000)
    }));
    const payload = JSON.stringify({
      exported_at: now(),
      app: 'VillaForge',
      version: VERSION,
      villaCount: villas.length,
      villas
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="villaforge-backup-${new Date(now()).toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store'
    });
    res.end(payload);
    return;
  }
  if (p === '/api/stats' && m === 'GET') {
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const count = (table) => one(`SELECT COUNT(*) c FROM ${table}`).c;
    return json(res, 200, {
      version: VERSION,
      ts: now(),
      uptimeSec: Math.round(process.uptime()),
      villas: count('villas'),
      agents: count('agents'),
      tasks: {
        total: count('tasks'),
        done: one("SELECT COUNT(*) c FROM tasks WHERE status = 'DONE'").c,
        open: one("SELECT COUNT(*) c FROM tasks WHERE status IN ('PENDING','READY','RUNNING','REVIEW')").c
      },
      memories: count('memories'),
      councilRounds: count('council'),
      audit: count('audit'),
      messages: count('messages'),
      runningVillas: listRunning(),
      routesHealth: (() => {
        // Aggregierte Route-Gesundheit: ein Blick reicht, um zu sehen, ob
        // Kontingente gerade drosseln oder alles ruhig laeuft.
        const rows = db.prepare('SELECT name, ok, fail, cooldown_until, priority FROM routes ORDER BY priority ASC').all();
        const cooling = rows.filter((r) => Number(r.cooldown_until || 0) > Date.now());
        return {
          ok: rows.reduce((a, r) => a + Number(r.ok || 0), 0),
          fail: rows.reduce((a, r) => a + Number(r.fail || 0), 0),
          cooling: cooling.map((r) => r.name),
          configured: rows.filter((r) => r.priority < 50 && (r.key_env ? !!resolveKey(r.key_env) : true)).length
        };
      })(),
      keyPools: keyPools(),
      // Pack-Zustand gehoert in die Statistik: ein Blick zeigt, ob Werkzeuge
      // gesperrt sind oder die Villa ihre volle Ausstattung hat.
      packs: packSummary(),
      limits: {
        ratePerMinute: RATE_LIMIT,
        tokenProtected: !!API_TOKEN
      },
      rssBytes: process.memoryUsage().rss
    });
  }

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

  // ---- Scheduler: Fortschrittsrang der Villen und Slot-Belegung ----
  if (p === '/api/scheduler' && m === 'GET') {
    return json(res, 200, { ...schedulerStatus(), llm: llmGateStatus(), cmd: cmdGateStatus(), ranking: villaRanking() });
  }

  // ---- Tools ----
  // Format bleibt ein Array (Web-UI, Android-App und Tests lesen es so).
  if (p === '/api/tools' && m === 'GET') return json(res, 200, toolSpecs());
  // Zusatzinfos zu den Werkzeugen: erlaubte Befehle und aktuelle Lastgrenzen.
  if (p === '/api/tools/meta' && m === 'GET') {
    return json(res, 200, { commands: ALLOWED, limits: { llm: llmGateStatus(), cmd: cmdGateStatus() } });
  }

  // ---- Projekt-Werkzeuge (fs-tools): lesen, durchsuchen, pruefen ----
  // Alle Pfade bleiben im Quellordner der Villa (safePath in fs-tools).
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'project') {
    const vid = Number(parts[2]);
    if (!db.prepare('SELECT id FROM villas WHERE id = ?').get(vid)) return json(res, 404, { error: 'Villa nicht gefunden' });
    const root = sourceRoot(vid);
    if (!root) return json(res, 409, { error: 'Fuer diese Villa ist kein Quellprojekt hinterlegt' });
    const sub = parts[4] || 'summary';
    if (sub === 'summary' && m === 'GET') return json(res, 200, projectSummary(root));
    if (sub === 'tree' && m === 'GET') return json(res, 200, { files: projectTree(root, Math.min(Number(url.searchParams.get('limit')) || 400, 2000)) });
    if (sub === 'search' && m === 'GET') {
      const q = String(url.searchParams.get('q') || '').slice(0, 200);
      if (!q) return json(res, 400, { error: 'Parameter q fehlt' });
      return json(res, 200, { query: q, hits: searchProject(root, q, Math.min(Number(url.searchParams.get('limit')) || 60, 200)) });
    }
    if (sub === 'read' && m === 'GET') {
      const f = String(url.searchParams.get('path') || '');
      if (!f) return json(res, 400, { error: 'Parameter path fehlt' });
      return json(res, 200, readProjectFile(root, f));
    }
    if (sub === 'check' && m === 'POST') {
      // Build/Test im Projekt, begrenzt durch die globale Befehls-Sperre.
      const b = await readBody(req);
      const bin = String(b.binary || 'npm');
      const out = await runCommand(root, bin, Array.isArray(b.args) ? b.args : ['test'], Math.min(Number(b.timeoutMs) || 120000, 180000));
      return json(res, out.ok ? 200 : 422, out);
    }
    return json(res, 404, { error: 'Unbekannter Projekt-Endpunkt' });
  }

  // ---- Feature- und Werkzeug-Packs ----
  // Eine Wahrheit fuer Hub, Web-UI und Android-App: /api/packs liefert alles,
  // was die Oberflaeche zum Anzeigen und Schalten braucht.
  if (p === '/api/packs' && m === 'GET') return json(res, 200, packState());
  if (p === '/api/tool-packs' && m === 'GET') {
    const state = packState();
    return json(res, 200, {
      master: state.master,
      packs: state.tools,
      features: state.features.map((f) => ({ id: f.id, title: f.title, enabled: f.enabled })),
      blocked: state.blocked
    });
  }
  if (parts[0] === 'api' && parts[1] === 'packs' && parts[2] && m === 'PATCH') {
    const b = await readBody(req);
    if (typeof b.enabled !== 'boolean') return json(res, 400, { error: 'enabled muss true oder false sein' });
    const out = setPackEnabled(parts[2], b.enabled);
    if (!out.ok) return json(res, 404, { error: out.error });
    emit('pack_updated', { id: parts[2], enabled: out.enabled });
    log(`Pack ${parts[2]}: ${out.enabled ? 'an' : 'aus'}`);
    return json(res, 200, { ok: true, pack: out, state: packState() });
  }

  // ---- Villas ----
  // Wartung: alte Protokolle und Chatverlaeufe aufraeumen.
  if (p === '/api/maintenance/prune' && m === 'POST') {
    const b = await readBody(req);
    const result = pruneOldData({ days: b?.days, dryRun: b?.dryRun === true });
    if (!result.ok) return json(res, 400, { error: result.error });
    emit('maintenance', { dryRun: result.dryRun, deleted: result.deleted.total });
    return json(res, 200, result);
  }
  if (p === '/api/villas' && m === 'GET') {
    // Deckel und Paginierung: ungebundene Listen waechsen unbrauchbar.
    // Die Antwort bleibt ein Array (App und Web-UI parsen genau das);
    // Gesamtzahl steht im X-Total-Count-Header, blaettern via ?limit=/?offset=.
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const rows = db.prepare("SELECT * FROM villas WHERE status != 'ARCHIVED' ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    const total = db.prepare("SELECT COUNT(*) c FROM villas WHERE status != 'ARCHIVED'").get().c;
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
  if (p === '/api/villas/import' && m === 'POST') {
    const b = await readBody(req);
    const result = importVilla(b, { nameOverride: String(b?.name || '').trim() });
    if (!result.ok) return json(res, 400, { error: result.error });
    log('Villa importiert:', result.villaId);
    return json(res, 201, result);
  }
  if (p === '/api/villas' && m === 'POST') {
    const b = await readBody(req);
    const v = validateVilla(b);
    if (!v.ok) return json(res, 400, { error: v.error });
    const result = await masterControl.createUniqueVilla(v.value);
    log('Villa angelegt:', result.villaId, `"${v.value.name}"`);
    return json(res, 201, result);
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'council' && m === 'GET') {
    return json(res, 200, listCouncil(Number(parts[2]), 10));
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'council' && m === 'POST') {
    if (!packEnabled('council')) return json(res, 409, { error: 'Der Rat der Agenten ist abgeschaltet (Feature-Pack „council").' });
    try {
      const out = await runCouncil(Number(parts[2]));
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts.length === 3 && m === 'PATCH') {
    const id = Number(parts[2]);
    const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(id);
    if (!villa) return json(res, 404, { error: 'Villa nicht gefunden' });
    const b = await readBody(req);
    const v = validateVillaPatch(b);
    if (!v.ok) return json(res, 400, { error: v.error });
    const fields = Object.keys(v.value);
    if (fields.length) {
      const sets = fields.map((f) => `${f} = ?`).join(', ');
      db.prepare(`UPDATE villas SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map((f) => v.value[f]), now(), id);
      emit('villa_updated', { villaId: id, fields });
    }
    return json(res, 200, { ok: true, villa: db.prepare('SELECT * FROM villas WHERE id = ?').get(id) });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts.length === 3 && m === 'DELETE') {
    const id = Number(parts[2]);
    const villa = db.prepare('SELECT id FROM villas WHERE id = ?').get(id);
    if (!villa) return json(res, 404, { error: 'Villa nicht gefunden' });
    if (isRunning(id)) return json(res, 409, { error: 'Villa laeuft gerade — erst stoppen, dann loeschen.' });
    for (const t of ['tasks', 'agents', 'messages', 'memories', 'audit', 'sources', 'reports']) {
      db.prepare(`DELETE FROM ${t} WHERE villa_id = ?`).run(id);
    }
    db.prepare('DELETE FROM villas WHERE id = ?').run(id);
    emit('villa_deleted', { villaId: id });
    log('Villa geloescht:', id);
    return json(res, 200, { deleted: id });
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
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'export' && m === 'GET') {
    const id = Number(parts[2]);
    const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(id);
    if (!villa) return json(res, 404, { error: 'Villa nicht gefunden' });
    const pick = (table, limit = 500) => db.prepare(`SELECT * FROM ${table} WHERE villa_id = ? ORDER BY id DESC LIMIT ?`).all(id, limit);
    const payload = {
      exported_at: now(),
      app: 'VillaForge',
      version: VERSION,
      villa,
      agents: pick('agents'),
      tasks: pick('tasks'),
      messages: pick('messages'),
      memories: pick('memories'),
      reports: pick('reports')
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="villa-${id}.json"`,
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
    return;
  }

  // Aufgaben einer Villa: filterbar nach Status, gedeckelt, sortiert nach Prioritaet.
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'tasks' && parts.length === 4 && m === 'GET') {
    const id = Number(parts[2]);
    if (!db.prepare('SELECT id FROM villas WHERE id = ?').get(id)) return json(res, 404, { error: 'Villa nicht gefunden' });
    const status = String(url.searchParams.get('status') || '').toUpperCase();
    if (status && !TASK_STATUSES.includes(status)) {
      return json(res, 400, { error: `status muss einer aus ${TASK_STATUSES.join(', ')} sein` });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
    const rows = status
      ? db.prepare('SELECT * FROM tasks WHERE villa_id = ? AND status = ? ORDER BY priority ASC, id ASC LIMIT ?').all(id, status, limit)
      : db.prepare('SELECT * FROM tasks WHERE villa_id = ? ORDER BY priority ASC, id ASC LIMIT ?').all(id, limit);
    return json(res, 200, rows);
  }
  // Audit-Protokoll mit Pagination — die Detailansicht bleibt bei den letzten 200 fix.
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'audit' && parts.length === 4 && m === 'GET') {
    const id = Number(parts[2]);
    if (!db.prepare('SELECT id FROM villas WHERE id = ?').get(id)) return json(res, 404, { error: 'Villa nicht gefunden' });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const entries = db.prepare('SELECT * FROM audit WHERE villa_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(id, limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS c FROM audit WHERE villa_id = ?').get(id).c;
    return json(res, 200, { villaId: id, total, limit, offset, entries });
  }
  // Einzelne Aufgabe bearbeiten: Status, Prioritaet, Ergebnis.
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'tasks' && parts[4] && m === 'PATCH') {
    const id = Number(parts[2]);
    const taskId = Number(parts[4]);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND villa_id = ?').get(taskId, id);
    if (!task) return json(res, 404, { error: 'Aufgabe nicht gefunden' });
    const b = await readBody(req);
    const v = validateTaskPatch(b);
    if (!v.ok) return json(res, 400, { error: v.error });
    if (task.status === 'RUNNING' && v.value.status && v.value.status !== 'RUNNING') {
      return json(res, 409, { error: 'Aufgabe laeuft gerade — erst beenden lassen oder die Villa stoppen.' });
    }
    const fields = Object.keys(v.value);
    if (fields.length) {
      const sets = fields.map((f) => `${f} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...fields.map((f) => v.value[f]), now(), taskId);
      emit('task_updated', { villaId: id, taskId, fields });
    }
    return json(res, 200, { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) });
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
    if (db.prepare('SELECT status FROM villas WHERE id=?').get(id)?.status === 'ARCHIVED') return json(res,409,{error:'Villa zuerst wiederherstellen.'});
    const schedule = scheduleVilla(id,check.value);
    return json(res,202,{ok:true,started:schedule.active.includes(id),queued:!schedule.active.includes(id),scheduler:schedule});
  }
  // Gescheiterte Aufgabe zurueck in die Warteschlange und den Lauf fortsetzen.
  // Nach einem Offline-Durchhaenger (PAUSED mit FAILED-Aufgaben) ist das der
  // eine Klick, der die Villa weiterlaufen laesst.
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'tasks' && parts[4] && parts[5] === 'retry' && m === 'POST') {
    const id = Number(parts[2]);
    const taskId = Number(parts[4]);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND villa_id = ?').get(taskId, id);
    if (!task) return json(res, 404, { error: 'Aufgabe nicht gefunden' });
    if (task.status !== 'FAILED') return json(res, 409, { error: 'Nur FAILED-Aufgaben koennen erneut gestartet werden' });
    db.prepare("UPDATE tasks SET status = 'PENDING', result = '', quota_blocked = 0, updated_at = ? WHERE id = ?").run(now(), taskId);
    db.prepare("INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,?)")
      .run(now(), id, 0, 'retry_task', JSON.stringify({ taskId }), 'Aufgabe #' + taskId + ' zurueck in die Warteschlange', 1);
    emit('task_updated', { villaId: id, taskId, fields: ['status'] });
    if (isRunning(id)) return json(res, 202, { ok: true, requeued: true, alreadyRunning: true });
    orchestrate(id, { concurrency: 4, maxTasks: 500, adaptive: true, maxRounds: 6 }).catch(() => {});
    return json(res, 202, { ok: true, requeued: true, started: true });
  }
  // Alle gescheiterten Aufgaben der Villa auf einmal.
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'retry-failed' && m === 'POST') {
    const id = Number(parts[2]);
    const info = db.prepare('SELECT * FROM villas WHERE id = ?').get(id);
    if (!info) return json(res, 404, { error: 'Villa nicht gefunden' });
    const n = db.prepare("UPDATE tasks SET status = 'PENDING', result = '', quota_blocked = 0, updated_at = ? WHERE villa_id = ? AND status = 'FAILED'")
      .run(now(), id).changes;
    if (n) {
      db.prepare("INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,?)")
        .run(now(), id, 0, 'retry_failed', JSON.stringify({ count: n }), n + ' gescheiterte Aufgabe(n) erneut gestartet', 1);
      emit('tasks_requeued', { villaId: id, count: n });
    }
    if (!n) return json(res, 200, { ok: true, requeued: 0, note: 'Keine FAILED-Aufgaben' });
    if (isRunning(id)) return json(res, 202, { ok: true, requeued: n, alreadyRunning: true });
    orchestrate(id, { concurrency: 4, maxTasks: 500, adaptive: true, maxRounds: 6 }).catch(() => {});
    return json(res, 202, { ok: true, requeued: n, started: true });
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
    // Replay nach Reconnect: EventSource sendet Last-Event-ID automatisch.
    const lastId = Number(req.headers['last-event-id']) || 0;
    for (const e of eventsSince(lastId)) {
      res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    }
    const onEvent = (e) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
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

  // Kontingent-Rueckkehr: pausierte Laeufe mit reinen 429-Fehlern einmal pro
  // Minute pruefen und faellige selbst fortsetzen — ohne Klick, ohne Weckruf.
  const autoResume = setInterval(() => {
    try {
      const out = autoResumeQuotaVillas({ orchestrate, isRunning });
      for (const id of out.resumed) log(`Auto-Resume: Villa ${id} nach Kontingent-Erschoepfung erneut gestartet`);
    } catch (err) { logError('Auto-Resume fehlgeschlagen:', err.message || err); }
  }, 60_000);
  autoResume.unref();
  // Superintelligenz-Loop (v1.11.0): alle 30 Minuten prueft der Hub, welche
  // Villa eine Rat-Runde faellig hat (aelter als 2 Stunden) und beruft sie
  // automatisch ein. Fehler duerfen den Hub-Takt niemals anhalten.
  const councilLoop = setInterval(() => {
    try { if (packEnabled('superintelligence')) autoCouncil({ isRunning }); } catch { /* Rat stoert Wartung nie */ }
  }, 30 * 60 * 1000);
  councilLoop.unref();
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
    for (const id of listRunning()) {
      try { stopVilla(id); } catch { /* Villa konnte nicht gestoppt werden — weitermachen */ }
      log(`Lauf der Villa ${id} gestoppt.`);
    }
    server.close(() => {
      log('Herunterfahren abgeschlossen.');
      process.exit(0);
    });
    // Notbremse, falls Verbindungen nicht schliessen.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
