import { VERSION } from './version.mjs';
import { studioStatus,proposeDesigns,selectDesign,createPreviewSession,serveStudioPreview } from './studio.mjs';
import { syncCascadeRoutes } from './llm-config.mjs';
import http from 'node:http';
import { createMasterControl } from './master-control.mjs';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { db, now } from './db.mjs';
import { FREE_ROUTE_CATALOG } from './routes.mjs';
import { chat, routingStatus, routingSummary, enabledRoutes, resolveKey, keyStatus } from './llm.mjs';
import { masterChat, masterHistory } from './master.mjs';
import { reapZombies } from './agents.mjs';
import { userStore, usersExist, userForRequest, userForToken, verifyPassword, createSession, destroyToken, upsertUser, publicUser, quotaLeft, FREE_DAILY_TOKENS } from './auth.mjs';
import { createVilla, runAgent, orchestrate, stopVilla, isRunning, TOOL_SPECS, toolSpecs, memoryContext, setSource, analyzeProject, refreshAgentPrompts, PROMPT_VERSION, ROLES, runTool } from './agents.mjs';
import { packState, packSummary, setPackEnabled } from './packs.mjs';
import { resumePendingVillas } from './resume.mjs';
import { schedulerStatus, villaRanking, enqueueVillas, configureScheduler, scheduleVilla, removeFromQueue } from './scheduler.mjs';
// v1.45.0 — SCORER + AUTOPILOT (Nutzerdirektive 2026-10-22): lokale 0-EUR-
// Heuristik bewertet DONE-Aufgaben, der Autopilot regelt die Flotte autonom
// (Slot-Filling, Orphan-Rescue, Route-Healing, Local-First-Report).
import { autopilotTick, startAutopilot, localFirstReport } from './autopilot.mjs';
import { startMessenger, messengerStatus } from './messenger.mjs';
import { scoresSnapshot, scoreRecentTasks, villaScores } from './scorer.mjs';
import { maintenanceTick, pruneOldData, dbSize } from './maintenance.mjs';
import { cmdGateStatus } from './fs-tools.mjs';
import { bus, emit } from './events.mjs';
import { runCouncil, listCouncil, autoCouncil } from './council.mjs';
import { runScout, listProposals, approveProposal, rejectProposal, explainVilla } from './scout.mjs';
import { maturity, developCycle, PHASES, proposalsToTasks } from './product.mjs';
import { evolutionState, proposeForVilla, evolveAll, listVillaProposals, listAllPending, approveVillaProposal, rejectVillaProposal, KINDS as EVOLVE_KINDS } from './evolve.mjs';
import { systemAudit, healTick, healActions } from './heal.mjs';
import { startBuild, buildStatus, buildArtifact, previewInfo, previewFile, maybeAutoBuild } from './builds.mjs';
import { createDeepProject, listDeepProjects, deepProjectDetail, deepChat, addDeepFile, deepFileById } from './deepagent.mjs';
import { keyforgeTick, keyforgeStatus } from './keyforge.mjs';
import { routeforgeTick, routeforgeStatus } from './routeforge.mjs';
import {
  initWebhookStore, claimEventId, markWebhookProcessed, logWebhookEvent,
  verifyStripeSignature, handleStripeEvent,
  verifyDigistore24Signature, handleDigistore24Event,
  authorizeUniversalRequest, gatewayStatus
} from './webhooks.mjs';
import { createReadStream, existsSync as fsExists } from 'node:fs';

const PORT = Number(process.env.PORT || 12000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = resolve(process.cwd(), 'server/public');

/* --------------------------- Villa-Live-Daten --------------------------- */
/* Was laeuft gerade, wie lange dauert es noch?                           */
/* ------------------------------------------------------------------ */

/** Titel der aktuell laufenden Aufgaben (max. 3) - "was macht die Villa?". */
function runningTaskTitles(villaId) {
  return db.prepare("SELECT title FROM tasks WHERE villa_id = ? AND status = 'RUNNING' ORDER BY updated_at ASC LIMIT 3")
    .all(villaId).map((r) => String(r.title).slice(0, 60));
}

/** Offene Aufgaben der Villa. */
function openCount(villaId) {
  return db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY','RUNNING')").get(villaId).c;
}

/**
 * ETA in Minuten: durchschnittliche Dauer der letzten 20 erledigten Aufgaben
 * dieser Villa (inkl. Wartezeit - ehrlich) mal offene Aufgaben, geteilt durch
 * die Villa-Parallelitaet. Ohne eigene History: Hausdurchschnitt.
 */
function etaMinutes(villaId) {
  const open = openCount(villaId);
  if (open === 0) return 0;
  let avg = db.prepare(
    "SELECT AVG(updated_at - created_at) d FROM (SELECT updated_at, created_at FROM tasks WHERE villa_id = ? AND status = 'DONE' ORDER BY id DESC LIMIT 20)"
  ).get(villaId).d;
  if (!avg || avg < 1000) {
    avg = db.prepare(
      "SELECT AVG(updated_at - created_at) d FROM (SELECT updated_at, created_at FROM tasks WHERE status = 'DONE' ORDER BY id DESC LIMIT 200)"
    ).get().d || 120_000;
  }
  const concurrency = Math.max(1, Math.min(2, Number(process.env.VF_MAX_CONCURRENCY) || 2));
  return Math.max(1, Math.round((avg * open) / concurrency / 60_000));
}

/* --------------------------- Protokoll --------------------------- */
// Ausgabe auf stdout/stderr. Im Daemon-Betrieb (scripts/daemon.sh) wird die
// Ausgabe in server/data/hub.log umgeleitet, damit sie einheitlich an einer
// Stelle landet und nicht doppelt geschrieben wird.
const log = (...a) => console.log(new Date().toISOString(), '[villaforge]', ...a);
const logError = (...a) => console.error(new Date().toISOString(), '[villaforge]', ...a);

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

/* --------------------------- Admin-Autoanlage --------------------------- */
// Optional: VF_ADMIN_EMAIL + VF_ADMIN_PASSWORD in der Umgebung des Hubs
// legen beim ersten Start automatisch ein Admin-Konto an (Plan: elite).
// Das Passwort wird ausschliesslich als Hash in der lokalen DB gespeichert.
initWebhookStore();

/* v1.44.0 — SUPERADMIN-Anker (Nutzerdirektive 2026-10-19): Der Administrator
 * aus VF_ADMIN_EMAIL wird bei JEDEM Start idempotent gesichert — Rolle
 * SUPERADMIN, Plan elite, is_unlimited=1 (tokenBudget UNLIMITED). Selbst bei
 * DB-Manipulation heilt der Account beim naechsten Start nach. Kein Passwort
 * im Code: Quelle ist die VM-Umgebung (Secret). */
if (process.env.VF_ADMIN_EMAIL && process.env.VF_ADMIN_PASSWORD) {
  try {
    upsertUser({ email: process.env.VF_ADMIN_EMAIL, password: process.env.VF_ADMIN_PASSWORD, role: 'superadmin', plan: 'elite', isUnlimited: true });
    log('SUPERADMIN dauerhaft verankert (unlimited Tokens, Plan elite).');
  } catch (err) {
    logError('SUPERADMIN-Anker fehlgeschlagen:', err.message || err);
  }
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
syncCascadeRoutes();
const masterControl = createMasterControl({ chat, createVilla, isRunning, stopVilla, toolSpecs, packState, setPackEnabled, emit, startVilla(id) { scheduleVilla(id); return { queued: id }; } });

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const parts = p.split('/').filter(Boolean); // ['api', ...]

  const user = userForRequest(req);
  // Offener Modus solange KEIN Nutzer existiert (Upgrade bestaehender Installationen
  // ohne Lockout) oder dauerhaft via VF_OPEN_MODE=1.
  const openMode = process.env.VF_OPEN_MODE === '1' || !usersExist();
  const needAuth = !openMode && !user;
  const isAdmin = !!user && (user.role === 'admin' || user.role === 'superadmin');

  if (m === 'OPTIONS' && p === '/api/health') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  /* v1.44.0 — MCP-GATEWAY (Model Context Protocol, Nutzerdirektive 2026-10-19):
   * JSON-RPC-2.0-Endpunkt fuer externe Tool-Clients und Agenten-Umgebungen.
   * Admin-Auth (Bearer) erforderlich. Methoden:
   *   initialize  -> Server-Info + Faehigkeiten (Handshake)
   *   tools/list  -> kompletter Werkzeugkatalog inkl. Tool-Packs
   *   tools/call  -> ECHTE Ausfuehrung ueber runTool im Villa-Kontext
   *                  (params.arguments.villa_id + args)
   * Das kaskadierende LLM-Routing (26 Routen, 429-Circuit-Breaker,
   * Millisekunden-Timeouts) liegt in llm.mjs und bleibt fuer alle
   * Agenten und MCP-vermittelten Werkzeuge wirksam. */
  if (m === 'OPTIONS' && p === '/api/mcp') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  if (p === '/api/mcp' && m === 'POST') {
    if (!isAdmin) {
      return json(res, 401, { jsonrpc: '2.0', error: { code: -32000, message: 'Admin-Login erforderlich (Bearer-Token).' }, id: null });
    }
    const body = await readBody(req).catch(() => null);
    const rid = body && body.id !== undefined ? body.id : null;
    const rpcErr = (code, message) => json(res, 200, { jsonrpc: '2.0', error: { code, message }, id: rid });
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return rpcErr(-32600, 'Ungueltige JSON-RPC-2.0-Anfrage (jsonrpc und method noetig).');
    }
    if (body.method === 'initialize') {
      return json(res, 200, {
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'villaforge-hub', version: VERSION }
        },
        id: rid
      });
    }
    if (body.method === 'tools/list') {
      return json(res, 200, {
        jsonrpc: '2.0',
        result: {
          tools: TOOL_SPECS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.schema || { type: 'object' },
            pack: t.pack,
            packTitle: t.packTitle
          }))
        },
        id: rid
      });
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name;
      const a = body.params?.arguments || {};
      if (!name) return rpcErr(-32602, 'params.name fehlt.');
      const villaId = Number(a.villa_id ?? a.villaId ?? 0);
      if (!villaId) return rpcErr(-32602, 'params.arguments.villa_id fehlt — Werkzeuge laufen im Villa-Kontext.');
      try {
        const toolArgs = a.args && typeof a.args === 'object' ? a.args : a;
        const out = await runTool({ villaId, agentId: 0 }, name, toolArgs);
        return json(res, 200, { jsonrpc: '2.0', result: { content: [{ type: 'text', text: String(out).slice(0, 60000) }] }, id: rid });
      } catch (err) {
        return rpcErr(-32000, `Werkzeugaufruf fehlgeschlagen: ${String(err?.message || err).slice(0, 300)}`);
      }
    }
    return rpcErr(-32601, `Unbekannte Methode: ${body.method}`);
  }
  if (p === '/api/system/audit') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const audit = systemAudit();
    return json(res, 200, { ...audit, actions: healActions() });
  }
  if (p === '/api/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Detaillierter Systemstatus fuer App-Monitoring und Watchdog:
    // CPU-Last, RAM, Disk, Uptime und Status der Kern-Dienste.
    const os = await import('node:os');
    const { statfsSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const svcStatus = (name) => {
      try {
        return execFileSync('systemctl', ['is-active', name], { timeout: 3000 }).toString().trim();
      } catch (e) {
        // systemctl liefert bei inaktivem Dienst Exit-Code 3
        const out = String((e.stdout || '')).trim();
        return out && out !== '' ? out : 'unbekannt';
      }
    };
    let disk = null;
    try {
      const st = statfsSync('/');
      disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize, usedPct: Math.round((1 - st.bavail / st.blocks) * 100) };
    } catch { /* statfs nicht verfuegbar */ }
    const total = os.totalmem(), free = os.freemem();
    const la = os.loadavg();
    return json(res, 200, {
      ok: true, capabilities:['llm-cascade-v1','verified-readiness-v1','studio-v1','master-control-v1'],masterControl:1,llm:routingSummary(), ts: now(), version: VERSION, routes: enabledRoutes().length,
      uptime: { processSec: Math.round(process.uptime()), systemSec: Math.round(os.uptime()) },
      cpu: { cores: os.cpus().length, load1: Number(la[0].toFixed(2)), load5: Number(la[1].toFixed(2)), load15: Number(la[2].toFixed(2)) },
      mem: {
        total, free, used: total - free,
        usedPct: Math.round(((total - free) / total) * 100),
        rss: process.memoryUsage().rss
      },
      disk,
      services: {
        hub: 'active',
        ollama: svcStatus('ollama'),
        nginx: svcStatus('nginx'),
        watchdog: svcStatus('cron')
      },
      scheduler: schedulerStatus(),
      cmd: cmdGateStatus(),
      db: dbSize()
    });
  }

  /* ------------- Unified Webhook Gateway (/api/v1/webhooks) -----------
   * Externe Systeme authentifizieren sich per Signatur bzw. Token — diese
   * Routen liegen bewusst VOR dem Session-Gate. Idempotenz: verarbeitete
   * Event-IDs werden per Redis (SET NX EX) abgegrenzt, Duplikate werden mit
   * Status 'duplicate' quittiert und NICHT doppelt verarbeitet.
   */
  if (p.startsWith('/api/v1/webhooks/')) {
    const sub = p.slice('/api/v1/webhooks/'.length);

    if (sub === 'status' && m === 'GET') {
      return json(res, 200, { ok: true, gateway: gatewayStatus() });
    }

    if (sub === 'stripe' && m === 'POST') {
      const raw = await readBody(req);
      const check = verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      if (!check.ok) return json(res, 400, { received: false, error: check.error });
      let event;
      try { event = JSON.parse(raw); } catch { return json(res, 400, { received: false, error: 'Kein gueltiges JSON' }); }
      const row = logWebhookEvent('stripe', event.id, { type: event.type });
      if (!await claimEventId('stripe', event.id)) {
        return json(res, 200, { received: true, duplicate: true, eventId: event.id });
      }
      const result = await handleStripeEvent(event);
      markWebhookProcessed('stripe', event.id);
      emit({ webhook: 'stripe', type: event.type });
      return json(res, 200, { received: true, eventId: event.id, handled: result.handled, slack: result.slack, logId: row?.id ?? null });
    }

    if (sub === 'digistore24' && m === 'POST') {
      const raw = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(raw));
      const check = verifyDigistore24Signature(params, process.env.DIGISTORE24_PASSPHRASE);
      if (!check.ok) return json(res, 400, { received: false, error: check.error });
      const eventId = String(params.transaction_id || params.order_id || `d24-${Date.now()}`);
      logWebhookEvent('digistore24', eventId, params);
      if (!await claimEventId('digistore24', `${eventId}:${params.etrigger ?? ''}`)) {
        return json(res, 200, { received: true, duplicate: true, eventId });
      }
      const result = await handleDigistore24Event(params);
      markWebhookProcessed('digistore24', eventId);
      emit({ webhook: 'digistore24', status: params.etrigger ?? null });
      return json(res, 200, { received: true, eventId, handled: result.handled, slack: result.slack });
    }

    if (sub === 'universal' && m === 'POST') {
      const auth = authorizeUniversalRequest(req);
      if (!auth.ok) return json(res, 401, { received: false, error: auth.error });
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { received: false, error: 'Kein gueltiges JSON' }); }
      const eventId = String(payload.event_id || payload.id || `uni-${Date.now()}`);
      logWebhookEvent('universal', eventId, payload);
      if (!await claimEventId('universal', eventId)) {
        return json(res, 200, { received: true, duplicate: true, eventId });
      }
      markWebhookProcessed('universal', eventId);
      emit({ webhook: 'universal', payload });
      const slack = process.env.SLACK_WEBHOOK_URL
        ? { sent: true, reason: '' }
        : { sent: false, reason: 'SLACK_WEBHOOK_URL nicht gesetzt' };
      return json(res, 200, { received: true, eventId, queued: true, slack });
    }

    return json(res, 404, { error: `Unbekannter Webhook-Endpunkt: ${p}` });
  }

  /* ------------- Oeffentliche Flotten-Bruecke (fuer CyberSarah) -----------
   * v1.47.0 — Liest das Control Center (Render) den VillaForge-Status ohne
   * Admin-Session: nur aggregierte, nicht-sensitive Flottendaten.
   */
  if (p === '/api/public/fleet' && m === 'GET') {
    return json(res, 200, {
      villas: db.prepare("SELECT status, COUNT(*) c FROM villas WHERE status!='ARCHIVED' GROUP BY status").all(),
      scheduler: schedulerStatus(),
      scores: villaScores().slice(0, 10).map((v) => ({ villaId: v.villaId, name: v.name, score: v.score, doneLastHour: v.doneLastHour, open: v.open, avgTaskScore: v.avgTaskScore })),
      scoredTasks: db.prepare('SELECT COUNT(*) c, ROUND(AVG(score),1) avg FROM task_scores').get(),
      localFirst: localFirstReport(),
      messenger: messengerStatus(),
      ts: Date.now(),
    });
  }

  /* --------------------------- Auth --------------------------- */
  if (p === '/api/auth/login' && m === 'POST') {
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(b.email || '').toLowerCase());
    if (!row || !verifyPassword(String(b.password || ''), row.password_hash)) {
      return json(res, 401, { error: 'E-Mail oder Passwort falsch.' });
    }
    const token = createSession(row.id);
    return json(res, 200, { token, user: publicUser(row), quotaLeft: quotaLeft(row) });
  }
  if (p === '/api/auth/me' && m === 'GET') {
    if (!user) return json(res, 200, { open: true, user: null });
    return json(res, 200, { open: openMode, user: publicUser(user), quotaLeft: quotaLeft(user) });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ')) destroyToken(header.slice(7).trim());
    return json(res, 200, { ok: true });
  }

  /* ------------------ Nutzer-Verwaltung (nur Admin) ------------------ */
  const usersApi = parts[0] === 'api' && parts[1] === 'users';
  if (usersApi && !isAdmin) {
    return json(res, isAdmin ? 400 : needAuth ? 401 : 403, { error: needAuth ? 'Login erforderlich.' : 'Nur Administratoren.' });
  }
  if (p === '/api/users' && m === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM users ORDER BY id ASC').all().map(publicUser));
  }
  if (p === '/api/users' && m === 'POST') {
    const b = await readBody(req);
    try {
      const u = upsertUser({ email: b.email, password: b.password, role: b.role || 'user', plan: b.plan || 'free' });
      return json(res, 201, publicUser(u));
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) });
    }
  }
  if (usersApi && parts[2] && m === 'DELETE') {
    const id = Number(parts[2]);
    if (user && user.id === id) return json(res, 400, { error: 'Eigenes Konto kann nicht geloescht werden.' });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Nutzer nicht gefunden.' });
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return json(res, 200, { ok: true });
  }

  // Alles weitere braucht einen Login, sobald Nutzer existieren.
  // Ausnahme: der SSE-Eventstrom (/api/events) laesst sich aus dem Browser
  // nicht mit Headern verbinden; er uebertraegt nur Fortschrittsereignisse.
  if (needAuth && p !== '/api/events') return json(res, 401, { error: 'Login erforderlich.' });
  if (await masterControl.handle(req, res, url, readBody, json, openMode || isAdmin)) return;

  // ---- Routen ----
  if(parts[0]==='api'&&parts[1]==='studio'&&parts[2]==='villas'&&/^\d+$/.test(parts[3]||'')) {
    const id=Number(parts[3]);
    if(parts.length===4&&m==='GET')return json(res,200,studioStatus(id));
    if(parts[4]==='designs'&&m==='POST')return json(res,200,await proposeDesigns(id));
    if(parts[4]==='design-selection'&&m==='POST'){const body=await readBody(req);return json(res,200,selectDesign(id,Number(body.designId),Number(body.index)));}
    if(parts[4]==='preview-session'&&m==='POST')return json(res,200,createPreviewSession(id));
  }
  if (p === '/api/llm/status' && m === 'GET') return json(res,200,routingStatus());
  if (p === '/api/routes' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM routes ORDER BY priority ASC, id ASC').all();
    return json(res, 200, rows.map((r) => ({ ...r, hasKey: r.provider === 'offline' || !!resolveKey(r.key_env) })));
  }
  if (p === '/api/routes' && m === 'POST') {
    if (!openMode && !isAdmin) return json(res, 403, { error: 'Routen anlegen ist Admins vorbehalten.' });
    const b = await readBody(req);
    const id = db.prepare(
      'INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(b.name || 'Route', b.provider || 'openai-compatible', b.baseUrl || '', b.model || '', b.keyEnv || '', b.isFree ? 1 : 0, 1, Number(b.priority) || 10, 1, 'NEW', 0, 0, 0).lastInsertRowid;
    return json(res, 201, { id });
  }
  if (parts[0] === 'api' && parts[1] === 'routes' && parts[2] && m === 'PATCH') {
    if (!openMode && !isAdmin) return json(res, 403, { error: 'Routen aendern ist Admins vorbehalten.' });
    const b = await readBody(req);
    if (typeof b.enabled === 'boolean') db.prepare('UPDATE routes SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, Number(parts[2]));
    if (b.priority != null) db.prepare('UPDATE routes SET priority = ? WHERE id = ?').run(Number(b.priority), Number(parts[2]));
    return json(res, 200, { ok: true });
  }
  if (parts[0] === 'api' && parts[1] === 'routes' && parts[2] && m === 'DELETE') {
    if (!openMode && !isAdmin) return json(res, 403, { error: 'Routen loeschen ist Admins vorbehalten.' });
    db.prepare('DELETE FROM routes WHERE id = ?').run(Number(parts[2]));
    return json(res, 200, { ok: true });
  }

  // ---- KeyForge / RouteForge (Master-Agent-Charta 2026-10-18) ----
  if (p === '/api/keyforge' && m === 'GET') {
    return json(res, 200, keyforgeStatus());
  }
  if (p === '/api/keyforge/tick' && m === 'POST') {
    if (!openMode && !isAdmin) return json(res, 403, { error: 'KeyForge-Tick ist Admins vorbehalten.' });
    const r = await keyforgeTick().catch((e) => ({ error: e.message || String(e) }));
    return json(res, 200, r);
  }
  if (p === '/api/routeforge' && m === 'GET') {
    return json(res, 200, routeforgeStatus());
  }
  if (p === '/api/routeforge/tick' && m === 'POST') {
    if (!openMode && !isAdmin) return json(res, 403, { error: 'RouteForge-Tick ist Admins vorbehalten.' });
    const r = routeforgeTick();
    return json(res, 200, r);
  }
  // ---- Secrets (nur Namen, niemals Werte; Admin-only, ausser offener Modus) ----
  if ((parts[0] === 'api' && parts[1] === 'secrets') && !openMode && !isAdmin) {
    return json(res, 403, { error: 'Schluessel-Verwaltung ist Admins vorbehalten.' });
  }
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
  // ---- Wartung: Altdaten bereinigen (Trockenlauf mit ?dryRun=1) ----
  if (p === '/api/maintenance' && m === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    return json(res, 200, maintenanceTick({ days: Number(b.days) || 30, dryRun: b.dryRun === true || url.searchParams.get('dryRun') === '1' }));
  }
  if (p === '/api/maintenance' && m === 'GET') {
    return json(res, 200, maintenanceTick({ dryRun: true }));
  }
  // ---- Scheduler: welche Villen laufen/warten, Rang nach Fortschritt ----
  if (p === '/api/scheduler' && m === 'GET') {
    return json(res, 200, { ...schedulerStatus(), ranking: villaRanking(), cmd: cmdGateStatus() });
  }
  if (p === '/api/scores' && m === 'GET') {
    return json(res, 200, { ...scoresSnapshot(), localFirst: localFirstReport() });
  }
  if (p === '/api/messenger' && m === 'GET') {
    return json(res, 200, messengerStatus());
  }
  if (p === '/api/tools' && m === 'GET') return json(res, 200, toolSpecs());
  // ---- Rollen-Katalog: alle verfuegbaren Agenten-Rollen inkl. AGI-Quintett ----
  if (p === '/api/roles' && m === 'GET') return json(res, 200, { roles: ROLES, promptVersion: PROMPT_VERSION });
  // ---- Packs: eine Wahrheit fuer Hub, Web-UI und Android-App ----
  if (p === '/api/packs' && m === 'GET') return json(res, 200, packState());
  if (p === '/api/tool-packs' && m === 'GET') return json(res, 200, packState().tools);
  if (p === '/api/packs' && m === 'PATCH') {
    const b = await readBody(req);
    const r = setPackEnabled(String(b.id || ''), !!b.enabled);
    return json(res, r.ok ? 200 : 400, r);
  }

  // ---- Villas ----
  if (p === '/api/villas' && m === 'GET') {
    // Live-Zustand ergaenzen: 'executing' = Rechen-Slot aktiv (arbeitet gerade),
    // 'queued' = autonomy an, aber kein Slot (Warteschlange). Sonst zeigen alle
    // aktiven Villen pauschal 'RUNNING' und niemand sieht, wer wirklich arbeitet.
    const rows = db.prepare("SELECT * FROM villas WHERE status != 'ARCHIVED' ORDER BY created_at DESC").all();
    return json(res, 200, rows.map((v) => ({
      ...v,
      executing: isRunning(v.id) ? 1 : 0,
      queued: (v.status === 'RUNNING' && v.autonomy === 1 && !isRunning(v.id)) ? 1 : 0,
      runningTasks: runningTaskTitles(v.id),
      openCount: openCount(v.id),
      etaMin: etaMinutes(v.id)
    })));

  }
  if (p === '/api/villas' && m === 'POST') {
    const b = await readBody(req);
    if (!b.idea) return json(res, 400, { error: 'idea fehlt' });
    const result = await masterControl.createUniqueVilla({
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
    villa.executing = isRunning(id) ? 1 : 0;
    villa.queued = (villa.status === 'RUNNING' && villa.autonomy === 1 && !isRunning(id)) ? 1 : 0;
    villa.runningTasks = runningTaskTitles(id);
    villa.openCount = openCount(id);
    villa.etaMin = etaMinutes(id);
    // Aufgaben begrenzen: eine reife Villa sammelt zehntausend Tasks - als
    // JSON mit vollem Result-Text sprengte das den 256-MB-Heap der Android-App
    // (OutOfMemoryError im org.json-Parsen). Offene zuerst, dann die neuesten
    // fertigen; Result-Texte nur als Vorschau, die Einzelaufgabe liefert alles.
    const openTasks = db.prepare("SELECT * FROM tasks WHERE villa_id = ? AND status != 'DONE' ORDER BY priority ASC, id ASC LIMIT 500").all(id);
    const doneTasks = db.prepare("SELECT * FROM tasks WHERE villa_id = ? AND status = 'DONE' ORDER BY id DESC LIMIT 300").all(id);
    const tasks = [...openTasks, ...doneTasks].map((t) => ({ ...t, result: String(t.result || '').slice(0, 500) }));
    const taskCounts = {};
    for (const row of db.prepare('SELECT status, COUNT(*) c FROM tasks WHERE villa_id = ? GROUP BY status').all(id)) {
      taskCounts[row.status.toLowerCase()] = row.c;
    }
    return json(res, 200, {
      villa,
      agents: db.prepare('SELECT * FROM agents WHERE villa_id = ? ORDER BY is_root DESC, id ASC').all(id),
      tasks,
      taskCounts,
      memories: db.prepare('SELECT * FROM memories WHERE villa_id = ? ORDER BY importance DESC, id DESC LIMIT 200').all(id),
      reports: db.prepare('SELECT id, villa_id, kind, title, content, created_at FROM reports WHERE villa_id = ? ORDER BY id DESC LIMIT 50').all(id),
      audit: db.prepare('SELECT * FROM audit WHERE villa_id = ? ORDER BY id DESC LIMIT 200').all(id),
      running: isRunning(id)
    });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts.length === 3 && m === 'DELETE') {
    if (!openMode && !isAdmin) return json(res, 403, { error: 'Nur Administratoren.' });
    const id = Number(parts[2]);
    const villa = db.prepare('SELECT * FROM villas WHERE id = ?').get(id);
    if (!villa) return json(res, 404, { error: 'Villa nicht gefunden' });

    if (isRunning(id) || villa.status === 'RUNNING') {
      stopVilla(id);
    }
    // v1.44.1 — Scheduler-Queue synchron halten: geloeschte Villa darf nicht
    // weiter in der Warteschlange liegen (Fokus-Slot laeuft sonst ins Leere).
    removeFromQueue(id);

    const targetTables = ['tasks', 'agents', 'memories', 'messages', 'audit', 'reports', 'council'];
    const counts = {};

    db.exec('BEGIN TRANSACTION;');
    try {
      for (const table of targetTables) {
        let cols = [];
        try {
          cols = db.prepare(`PRAGMA table_info(${table})`).all();
        } catch (_) {}
        if (cols.some((c) => c.name === 'villa_id')) {
          const cRow = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE villa_id = ?`).get(id);
          counts[table] = cRow ? Number(cRow.c) : 0;
          db.prepare(`DELETE FROM ${table} WHERE villa_id = ?`).run(id);
        }
      }
      db.prepare('DELETE FROM villas WHERE id = ?').run(id);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      return json(res, 500, { error: String(err.message || err) });
    }

    return json(res, 200, { ok: true, deleted: id, counts });
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
    scheduleVilla(id, { concurrency: Number(b.concurrency) || 0, maxRounds: Number(b.maxRounds) || 6 }); // 0 = automatisch, eine Villa nach der anderen
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
      ? db.prepare('SELECT * FROM messages WHERE villa_id = ? AND agent_id = ? ORDER BY id ASC LIMIT 400').all(id, agentId)
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
    if(res2.code==='LLM_UNAVAILABLE')return json(res,503,{error:res2.error,code:res2.code,retryAfter:15});
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
    if(r.code==='LLM_UNAVAILABLE')return json(res,503,{error:r.error,code:r.code,retryAfter:15});
    return json(res, 200, r);
  }

  // ---- SSE ----

  /* ---- Mission Control (Port aus Agentforge2 v1.11): Stats, Rat, Aufgaben, Audit ---- */
  if (p === '/api/stats' && m === 'GET') {
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const count = (table) => one(`SELECT COUNT(*) c FROM ${table}`).c;
    const rows = db.prepare('SELECT name, ok, fail, cooldown_until, priority FROM routes ORDER BY priority ASC').all();
    const cooling = rows.filter((r) => Number(r.cooldown_until || 0) > Date.now());
    return json(res, 200, {
      version: VERSION,llm:routingSummary(), ts: now(), uptimeSec: Math.round(process.uptime()),
      packs: packSummary(),
      villas: one("SELECT COUNT(*) c FROM villas WHERE status != 'ARCHIVED'").c, agents: count('agents'),
      tasks: { total: count('tasks'), done:one("SELECT COUNT(*) c FROM tasks WHERE status='DONE'").c,failed:one("SELECT COUNT(*) c FROM tasks WHERE status='FAILED'").c, open: one("SELECT COUNT(*) c FROM tasks WHERE status IN ('PENDING','READY','RUNNING','REVIEW')").c },
      memories: count('memories'), councilRounds: count('council'), audit: count('audit'), messages: count('messages'),
      runningVillas: db.prepare("SELECT id FROM villas WHERE status = 'RUNNING'").all().map((r) => r.id),
      maturity: db.prepare('SELECT id, name FROM villas').all().map((v) => { const mt = maturity(v.id); return { villaId: v.id, name: v.name, score: mt.score, planScore:mt.planScore,verified:mt.verified,blockers:mt.blockers,stage: mt.stage, phase: mt.currentPhase,currentPhase:mt.currentPhase }; }),
      routesHealth: {
        ok: rows.reduce((a, r) => a + Number(r.ok || 0), 0),
        fail: rows.reduce((a, r) => a + Number(r.fail || 0), 0),
        cooling: cooling.length, total: rows.length
      }
    });
  }
  /* ---- Innovations-Scout (v1.25): bessere Alternativen, Erklaerung was/warum/wie ---- */
  if (p === '/api/proposals' && m === 'GET') {
    return json(res, 200, listProposals());
  }
  if (p === '/api/proposals/scan' && m === 'POST') {
    const r = await runScout({ force: true }).catch((e) => { throw new Error('Scout fehlgeschlagen: ' + String(e.message || e).slice(0, 200)); });
    return json(res, 200, { ok: true, ...r });
  }
  if (parts[0] === 'api' && parts[1] === 'proposals' && parts[2] && parts[3] === 'approve' && m === 'POST') {
    const r = await approveProposal(Number(parts[2]), createVilla);
    return json(res, 201, { ok: true, ...r });
  }
  if (parts[0] === 'api' && parts[1] === 'proposals' && parts[2] && parts[3] === 'reject' && m === 'POST') {
    return json(res, 200, rejectProposal(Number(parts[2])));
  }
  /* ---- Villa-Evolution (v1.30): jede Villa schlaegt selbst naechste Phasen/Perfektion/Marketplace vor ---- */
  if (p === '/api/evolution/pending' && m === 'GET') {
    return json(res, 200, listAllPending());
  }
  if (parts[0] === 'api' && parts[1] === 'evolution' && parts[2] === 'villas' && parts[3] && !parts[4] && m === 'GET') {
    const id = Number(parts[3]);
    const st = evolutionState(id);
    if (!st) return json(res, 404, { error: 'Villa nicht gefunden' });
    return json(res, 200, {
      villaId: id, stage: st.stage, open: st.open, done: st.done, failed: st.failed,
      phaseRounds: st.rounds, developmentComplete: st.developmentComplete, workspaceEmpty: st.workspaceEmpty,
      maturity: st.maturity.score, proposals: listVillaProposals(id)
    });
  }
  if (parts[0] === 'api' && parts[1] === 'evolution' && parts[2] === 'villas' && parts[3] && parts[4] === 'propose' && m === 'POST') {
    const kind = String((await readBody(req))?.kind || '').toUpperCase();
    if (!EVOLVE_KINDS.includes(kind)) return json(res, 400, { error: 'kind muss NEXT_PHASES, PERFECT oder MARKETPLACE sein.' });
    try { return json(res, 200, await proposeForVilla(Number(parts[3]), kind)); }
    catch (e) { return json(res, 409, { error: String(e.message || e).slice(0, 300) }); }
  }
  if (p === '/api/evolution/tick' && m === 'POST') {
    return json(res, 200, { made: await evolveAll({ maxPerTick: 3 }) });
  }
  if (parts[0] === 'api' && parts[1] === 'evolution' && parts[2] === 'proposals' && parts[3] && parts[4] === 'approve' && m === 'POST') {
    try {
      const r = approveVillaProposal(Number(parts[3]));
      if (r.added > 0 && !isRunning(r.villaId)) scheduleVilla(r.villaId, { concurrency: 0, maxRounds: 6 });
      return json(res, 200, r);
    } catch (e) { return json(res, 409, { error: String(e.message || e) }); }
  }
  if (parts[0] === 'api' && parts[1] === 'evolution' && parts[2] === 'proposals' && parts[3] && parts[4] === 'reject' && m === 'POST') {
    try { return json(res, 200, rejectVillaProposal(Number(parts[3]))); }
    catch (e) { return json(res, 409, { error: String(e.message || e) }); }
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'explain' && m === 'POST') {
    return json(res, 200, await explainVilla(Number(parts[2])));
  }

  /* ---- Produkt-Build-Pipeline (v1.24): Status, Start, Download, Vorschau ---- */
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'build' && parts[4] === 'download' && m === 'GET') {
    const id = Number(parts[2]);
    const art = buildArtifact(id);
    if (!art) return json(res, 404, { error: 'Kein Build-Artefakt bereit. Erst bauen lassen.' });
    res.writeHead(200, {
      'Content-Type': art.mime,
      'Content-Length': statSync(art.file).size,
      'Content-Disposition': `attachment; filename="${art.name}"`,
      'Cache-Control': 'no-store'
    });
    createReadStream(art.file).pipe(res);
    return;
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'build' && m === 'GET') {
    return json(res, 200, buildStatus(Number(parts[2])));
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'build' && m === 'POST') {
    const id = Number(parts[2]);
    try {
      const rec = await startBuild(id);
      return json(res, 202, rec);
    } catch (e) {
      return json(res, 409, { error: String(e.message || e) });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'preview' && !parts[4] && m === 'GET') {
    return json(res, 200, previewInfo(Number(parts[2])));
  }

  /* ---- Deep Agent: eigene App-Projekte abseits der Villen (v1.37.0) ---- */
  if (p === '/api/deep/projects' && m === 'GET') {
    return json(res, 200, listDeepProjects());
  }
  if (p === '/api/deep/projects' && m === 'POST') {
    try {
      const b = await readBody(req);
      return json(res, 200, await createDeepProject(b?.idea));
    } catch (e) {
      return json(res, 400, { error: String(e.message || e).slice(0, 300) });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'deep' && parts[2] === 'projects' && parts[3] && parts[4] === 'chat' && m === 'POST') {
    try {
      const b = await readBody(req);
      const r = await deepChat(Number(parts[3]), b?.message || '', Array.isArray(b?.attachments) ? b.attachments : []);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: String(e.message || e).slice(0, 300) });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'deep' && parts[2] === 'projects' && parts[3] && parts[4] === 'files' && m === 'POST') {
    try {
      const b = await readBody(req);
      return json(res, 200, addDeepFile(Number(parts[3]), b?.name, b?.mime, b?.data));
    } catch (e) {
      return json(res, 400, { error: String(e.message || e).slice(0, 300) });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'deep' && parts[2] === 'files' && parts[3] && m === 'GET') {
    const f = deepFileById(Number(parts[3]));
    if (!f) return json(res, 404, { error: 'Anhang nicht gefunden' });
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'no-store' });
    createReadStream(f.file).pipe(res);
    return;
  }
  if (parts[0] === 'api' && parts[1] === 'deep' && parts[2] === 'projects' && parts[3] && !parts[4] && m === 'GET') {
    const d = deepProjectDetail(Number(parts[3]));
    if (!d) return json(res, 404, { error: 'Projekt nicht gefunden' });
    return json(res, 200, d);
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'preview' && parts[4] && m === 'GET') {
    const f = previewFile(Number(parts[2]), parts.slice(4).join('/'));
    if (!f) return json(res, 404, { error: 'Keine Vorschau-Datei' });
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'no-store', 'Content-Security-Policy':"sandbox allow-scripts; frame-ancestors 'self'; form-action 'none'", 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff' });
    if (f.mime.startsWith('text/html')) {
      /* Absolute Asset-Pfade auf den Vorschau-Pfad umlenken, damit Bundles
         (z. B. Vite "/assets/...") in der Live-Ansicht ebenfalls laden. */
      const html = readFileSync(f.file, 'utf8').replace(/(src|href)=("|')\//g, '$1=$2');
      return res.end(html);
    }
    createReadStream(f.file).pipe(res);
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'council' && parts.length === 4 && m === 'GET') {
    return json(res, 200, listCouncil(Number(parts[2]), 10));
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'council' && parts.length === 4 && m === 'POST') {
    try {
      const out = await runCouncil(Number(parts[2]));
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'council' && parts[4] === 'adopt' && m === 'POST') {
    try {
      const b = await readBody(req);
      const roundId = Number(b?.round) || 0;
      const round = roundId
        ? db.prepare('SELECT * FROM council WHERE villa_id = ? AND id = ?').get(Number(parts[2]), roundId)
        : db.prepare('SELECT * FROM council WHERE villa_id = ? ORDER BY id DESC').get(Number(parts[2]));
      if (!round) return json(res, 404, { error: 'Keine Rat-Runde gefunden.' });
      let proposals = [];
      try { proposals = JSON.parse(round.proposals); } catch { proposals = []; }
      const added = proposalsToTasks(Number(parts[2]), proposals);
      db.prepare('INSERT INTO reports (villa_id, kind, title, content, data, created_at) VALUES (?,?,?,?,?,?)')
        .run(Number(parts[2]), 'COUNCIL', `Rat Runde ${round.round} uebernommen`, `Vorschlaege der Runde ${round.round} wurden per Bestaetigung als Aufgaben uebernommen (neu: ${added}).`, JSON.stringify(proposals), now());
      return json(res, 200, { ok: true, roundId: round.id, round: round.round, proposals: proposals.length, added });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'tasks' && parts.length === 4 && m === 'GET') {
    const id = Number(parts[2]);
    if (!db.prepare('SELECT id FROM villas WHERE id = ?').get(id)) return json(res, 404, { error: 'Villa nicht gefunden' });
    const status = String(url.searchParams.get('status') || '').toUpperCase();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
    const rows = status
      ? db.prepare('SELECT * FROM tasks WHERE villa_id = ? AND status = ? ORDER BY priority ASC, id ASC LIMIT ?').all(id, status, limit)
      : db.prepare('SELECT * FROM tasks WHERE villa_id = ? ORDER BY priority ASC, id ASC LIMIT ?').all(id, limit);
    // Result-Texte als Vorschau: Werkzeug-Ausgaben koennen 6.000 Zeichen haben,
    // 500 davon wuchsen die Liste auf Megabytes (OOM-Gefahr auf dem Handy).
    return json(res, 200, rows.map((t) => ({ ...t, result: String(t.result || '').slice(0, 2000) })));
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'tasks' && parts[4] && parts[5] === 'retry' && m === 'POST') {
    const id = Number(parts[2]), taskId = Number(parts[4]);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND villa_id = ?').get(taskId, id);
    if (!task) return json(res, 404, { error: 'Aufgabe nicht gefunden' });
    if (task.status === 'RUNNING') return json(res, 409, { error: 'Aufgabe laeuft gerade.' });
    db.prepare("UPDATE tasks SET status = 'PENDING', updated_at = ? WHERE id = ?").run(now(), taskId);
    return json(res, 200, { ok: true });
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'audit' && parts.length === 4 && m === 'GET') {
    const id = Number(parts[2]);
    if (!db.prepare('SELECT id FROM villas WHERE id = ?').get(id)) return json(res, 404, { error: 'Villa nicht gefunden' });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const entries = db.prepare('SELECT * FROM audit WHERE villa_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(id, limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS c FROM audit WHERE villa_id = ?').get(id).c;
    return json(res, 200, { villaId: id, total, limit, offset, entries });
  }


  // Produkt-Pipeline: Marktreife, Phasen und Entwicklungszyklus je Villa.
  if (p === '/api/product/phases' && m === 'GET') return json(res, 200, PHASES.map(({ id, title, goal, weight }) => ({ id, title, goal, weight })));
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'product' && m === 'GET') {
    const id = Number(parts[2]);
    if (!db.prepare('SELECT id FROM villas WHERE id = ?').get(id)) return json(res, 404, { error: 'Villa nicht gefunden' });
    return json(res, 200, maturity(id));
  }
  if (parts[0] === 'api' && parts[1] === 'villas' && parts[2] && parts[3] === 'develop' && m === 'POST') {
    const id = Number(parts[2]);
    if (!db.prepare('SELECT id FROM villas WHERE id = ?').get(id)) return json(res, 404, { error: 'Villa nicht gefunden' });
    const out = developCycle(id);
    if (out.added > 0 && !isRunning(id)) scheduleVilla(id, { concurrency: 0, maxRounds: 6 });
    return json(res, 200, { ok: true, added: out.added, maturity: out.maturity.score, stage: out.maturity.stage, phase: out.maturity.currentPhase });
  }
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
export const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if(serveStudioPreview(req,res,url))return;
  if (url.pathname.startsWith('/api/')) {
    // Nutzer-Kontext fuer alle LLM-Aufrufe dieses Requests (inkl. Hintergrund-Lauefe)
    userStore.run(userForRequest(req), () => {
      api(req, res, url).catch((err) => {
        if (String(err.message || '').includes('QUOTA_EXCEEDED')) {
          json(res, 429, { error: 'Tageskontingent aufgebraucht. Der Plan elite ist unbegrenzt.' });
        } else {
          json(res, err.statusCode || 500, { error: String(err.message || err), code:err.code, retryAfter:err.retryAfter });
        }
      });
    });
  } else {
    serveStatic(req, res, url.pathname);
  }
});

// Prompt-Migration: alle bestehenden Agenten auf die aktuelle Rollen-Qualitaet
// heben (idempotent, laeuft bei jedem Start, aendert nur veraltete Prompts).
const refreshedPrompts = refreshAgentPrompts();
if (refreshedPrompts > 0) log(`Prompt-Upgrade v${PROMPT_VERSION}: ${refreshedPrompts} Agent(en) aktualisiert.`);

server.listen(PORT, HOST, () => {
  log(`Hub laeuft auf http://${HOST}:${PORT}`);
  log(`UI:      http://localhost:${PORT}/`);
  log(`Health:  http://localhost:${PORT}/api/health`);
  // Superintelligenz-Loop: alle 30 Min wird jede Villa mit faelliger Rat-Runde (>2 h) einberufen.
  const councilLoop = setInterval(() => {
    try { autoCouncil({ isRunning }); } catch { /* Rat stoert den Hub-Takt nie */ }
  }, 30 * 60 * 1000);
  councilLoop.unref();
  // Innovations-Scout: alle 6 h eine bessere Alternative vorschlagen (erster Lauf nach 3 min).
  setTimeout(() => { runScout().catch(() => {}); }, 3 * 60 * 1000).unref?.();
  const scoutLoop = setInterval(() => {
    try { runScout().catch(() => {}); } catch { /* Scout stoert den Takt nie */ }
  }, 6 * 60 * 60 * 1000);
  scoutLoop.unref();
  // Zombie-Reaper: haengende RUNNING-Aufgaben (>35 Min) beenden, damit keine
  // Villa durch eine ewig wartende Batch blockiert wird. Sofort + alle 15 Min.
  reapZombies();
  const reapLoop = setInterval(() => { try { reapZombies(); } catch { /* nie fatal */ } }, 15 * 60 * 1000);
  reapLoop.unref();
  // Villa-Evolution: erledigte Villen schlagen selbst naechste Phasen / Perfektion / Marketplace vor.
  setTimeout(() => { evolveAll().catch(() => {}); }, 5 * 60 * 1000).unref?.();
  const evolveLoop = setInterval(() => {
    evolveAll({ maxPerTick: 3 }).then((made) => {
      const ok = made.filter((x) => x.created);
      if (ok.length) log(`Evolution: ${ok.length} neue Vorschlaege (${ok.map((x) => `V${x.villaId}:${x.kind}`).join(', ')})`);
    }).catch((e) => logError('Evolution:', e.message || e));
  }, 30 * 60 * 1000);
  evolveLoop.unref();
  // AUTONOME SELBSTHEILUNG: alle 10 Min den Heil-Takt laufen lassen - analysiert
  // Fehlschlaege per LLM, legt/genehmigt REPARATUR-Aufgaben automatisch und prueft
  // danach das ganze System. Erst wenn alles gruen ist, reine Ueberwachung.
  setTimeout(() => { healTick().catch(() => {}); }, 3 * 60 * 1000).unref?.();
  const healLoop = setInterval(() => {
    healTick({ maxRepairs: 2 }).then((r) => {
      if (r.actions.length) log(`Selbstheilung: ${r.actions.length} Aktion(en), System ${r.audit.green ? 'GRUEN' : 'ROT (' + r.audit.areas.filter((a) => !a.green).map((a) => a.name).join(', ') + ')'}`);
      else if (!r.audit.green) log(`Selbstheilung: System noch ROT (${r.audit.areas.filter((a) => !a.green).map((a) => a.name).join(', ')}) - weitere Takte folgen`);
    }).catch((e) => logError('Selbstheilung:', e.message || e));
  }, 10 * 60 * 1000);
  healLoop.unref();
  // 24/7-Dauerentwicklung: alle 20 Min bekommt jede Villa ohne laufenden Lauf einen
  // Entwicklungszyklus (Phasen-Pflichten, sonst Verbesserungswelle) und wird gestartet.
  // Wartungs-Loop: alle 6 Stunden Historie rotieren und Altdaten (>30 Tage)
  // entfernen. Ohne diese Rotation wuchs die DB auf 157 MB und machte jede
  // Abfrage langsamer - der Hub haengt nicht am Speicher, sondern am Vollscan.
  const maintenanceLoop = setInterval(() => {
    try {
      const r = maintenanceTick({ days: 30 });
      if (r.deleted.total > 0 || r.rotated.audit > 0) {
        log(`Wartung: ${r.rotated.audit} Audit-/Memoria-Zeilen rotiert, ${r.deleted.total} Altdaten geloescht`);
      }
    } catch (e) { logError('Wartung:', e.message || e); }
  }, 6 * 60 * 60 * 1000);
  maintenanceLoop.unref();

  // KEYFORGE-AGENT: Secrets-Store scannen, neue Keys identifizieren/validieren
  // und Routen anlegen (Charta 2026-10-18). Erster Lauf nach 90 s, dann alle 10 Min.
  setTimeout(() => { keyforgeTick().catch((e) => logError('KeyForge:', e.message || e)); }, 90 * 1000).unref?.();
  const keyforgeLoop = setInterval(() => {
    keyforgeTick()
      .then((r) => { if (r.actions.length) log(`KeyForge: ${r.actions.length} neue Route(n) angelegt`); })
      .catch((e) => logError('KeyForge:', e.message || e));
  }, 10 * 60 * 1000);
  keyforgeLoop.unref();

  // ROUTEFORGE-AGENT: Routen-Gesundheit bewerten und Prioritaeten anpassen
  // (Sturm-Routen runter, Erholung hoch) - alle 5 Min.
  const routeforgeLoop = setInterval(() => {
    try {
      const r = routeforgeTick();
      if (r.actions.length) log(`RouteForge: ${r.actions.length} Prioritaets-Anpassung(en)`);
    } catch (e) { logError('RouteForge:', e.message || e); }
  }, 5 * 60 * 1000);
  routeforgeLoop.unref();
  // Start-Wartung: einmal nach 2 Minuten, danach im Takt.
  setTimeout(() => { try { maintenanceTick({ days: 30 }); } catch { /* */ } }, 2 * 60 * 1000).unref?.();
  const developLoop = setInterval(() => {
    try {
      // Dauerentwicklung: Entwicklungszyklus fuer jede freie Villa, aber der
      // START laeuft ueber den Scheduler: nur VF_VILLA_SLOTS Villen gleichzeitig,
      // die am weitesten fortgeschrittenen zuerst. Vorher startete dieser Loop
      // alle Villen direkt - 11 Laeufe x Agenten auf 4 Kernen brachten den Hub
      // regulaessig zum Stillstand.
      const ready = [];
      for (const v of db.prepare('SELECT id, autonomy FROM villas').all()) {
        if (v.autonomy === 0 || isRunning(v.id)) continue;
        const out = developCycle(v.id);
        if (out.added) log(`Dauerentwicklung Villa ${v.id}: +${out.added} Aufgaben, Reife ${out.maturity.score}/100 (${out.maturity.currentPhase})`);
        const open = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY')").get(v.id).c;
        if (open > 0) ready.push(v.id);
      }
      if (ready.length) {
        for (const rid of ready) scheduleVilla(rid, { concurrency: 0, maxRounds: 6 });
      }
    } catch (e) { logError('Dauerentwicklung:', e.message || e); }
  }, 5 * 60 * 1000); // 24/7: Wächter prueft alle 5 Minuten, der Orchestrator selbst laeuft durchgehend
  developLoop.unref();


  // AUTOPILOT (v1.45.0): Scorer + autonomer Flottenregler — erster Takt nach
  // 90 s, danach alle 5 Min (Setting 'autopilot' = 0 schaltet ihn ab).
  startAutopilot();

  // MESSENGER-TRIGGER (v1.46.0): Telegram-Fernsteuerung, inaktiv ohne Token.
  startMessenger();

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
