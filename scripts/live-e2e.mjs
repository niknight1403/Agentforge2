#!/usr/bin/env node
/**
 * VillaForge Live-E2E: faehrt den echten Hub in einem echten Chrome durch.
 *
 * Der Test startet eine eigene Hub-Instanz (eigene Datenbank, eigener
 * Workspace, ohne externe LLM-Keys und mit lokalem deterministischen Modellstub), oeffnet die Web-Oberflaeche in
 * Chrome und klickt den kompletten Weg durch: Villa anlegen, Arbeitsbereich
 * oeffnen, alle Tabs, Chat, Entwicklung starten/stoppen, Filter. Alles, was
 * dabei schiefgeht — Konsolenfehler, 5xx-Antworten, abgebrochene Anfragen —
 * landet im Report und auf der Platte (Screenshots unter artifacts/live-e2e/).
 *
 * Aufruf:
 *   node scripts/live-e2e.mjs                 # kompletter Durchlauf
 *   node scripts/live-e2e.mjs --keep          # Artefakte der letzten Runde behalten
 *   node scripts/live-e2e.mjs --out ordner    # Ziel fuer Report + Screenshots
 *   node scripts/live-e2e.mjs --headful       # sichtbares Fenster (Debugging)
 *
 * Exit-Code 0 = alles gruen, 1 = mindestens eine Pruefung rot.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchChrome, newTarget, Page, delay } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT_DIR = resolve(ROOT, arg('out', 'artifacts/live-e2e'));
const SHOTS = join(OUT_DIR, 'screenshots');
const KEEP = has('keep');
const PORT = Number(arg('port', 12150 + Math.floor(Math.random() * 40)));
const CDP_PORT = Number(arg('cdp-port', 9400 + Math.floor(Math.random() * 40)));
const VILLA_IDEA = 'Live-E2E Pruefung: VillaForge Oberflaeche, Agenten und Werkzeuge verifizieren';

const results = [];
const started = Date.now();
let hub = null;
let chrome = null;
let page = null;
let workDir = null;
let modelMock = null;
let villaId = null;

function step(name) {
  const record = { name, status: 'running', ms: 0, note: '' };
  results.push(record);
  const t0 = Date.now();
  process.stdout.write(`\u25b8 ${name} `);
  return {
    ok(note = '') { record.status = 'pass'; record.ms = Date.now() - t0; record.note = note; console.log(`\u2714 ${note}`); },
    fail(error) {
      record.status = 'fail';
      record.ms = Date.now() - t0;
      record.note = String(error?.message || error);
      console.log(`\u2716 ${record.note}`);
    },
    skip(note) { record.status = 'skip'; record.note = note; console.log(`\u2013 ${note}`); }
  };
}

async function check(name, fn) {
  const s = step(name);
  try { const note = await fn(); s.ok(note || ''); } catch (err) {
    s.fail(err);
    await safeShot(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  }
}

async function safeShot(label) {
  if (!page || !page.connected) return null;
  try { return await page.screenshot(join(SHOTS, `${label}.png`)); } catch { return null; }
}

/* ------------------------- Hub starten ------------------------- */
async function startHub() {
  workDir = mkdtempSync(join(tmpdir(), 'vf-live-'));
  modelMock = await startMockLlm();
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    VF_DB: join(workDir, 'hub.db'),
    VF_WORKSPACE: join(workDir, 'workspace'),
    VF_LOG_FILE: join(workDir, 'hub.log'),
    VF_RESUME: '0',
    VF_LOCAL_LLM_URL: modelMock.url,
    VF_LOCAL_LLM_MODEL: 'villa-test'
  };
  // Keine LLM-Schluessel: der Offline-Planer muss den Test allein tragen.
  for (const k of Object.keys(env)) if (/^(GROQ|GEMINI|CEREBRAS|MISTRAL|TOGETHER|OPENROUTER|DEEPSEEK)_API_KEY/.test(k)) delete env[k];

  hub = spawn(process.execPath, ['server/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stdout.on('data', (d) => { if (has('verbose')) process.stdout.write(`[hub] ${d}`); });
  hub.stderr.on('data', (d) => { if (has('verbose')) process.stdout.write(`[hub:err] ${d}`); });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (hub.exitCode != null) throw new Error(`Hub beendet (Code ${hub.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* noch nicht bereit */ }
    await delay(150);
  }
  throw new Error('Hub wurde nicht erreichbar');
}

/* --------------------------- Ablauf --------------------------- */
async function run() {
  await check('Hub startet und meldet Health', async () => {
    const h = await startHub();
    if (!h.ok) throw new Error('Health meldet kein ok');
    return `v${h.version}, ${h.routes} Routen`;
  });

  await check('Chrome startet (headless)', async () => {
    chrome = await launchChrome({ port: CDP_PORT, headless: !has('headful') });
    return `${chrome.version.Browser || 'Chrome'} ${chrome.version['User-Agent'] ? '' : ''}`.trim();
  });

  await check('Seite laedt und meldet sich am Hub an', async () => {
    const target = await newTarget(chrome.base, `http://127.0.0.1:${PORT}/`);
    page = await Page.attach(target.webSocketDebuggerUrl);
    await page.enableAll();
    await page.setViewport(1440, 960);
    await page.navigate(`http://127.0.0.1:${PORT}/`);
    const title = await page.evaluate('return document.title;');
    if (!/VillaForge/.test(title)) throw new Error(`Falscher Titel: ${title}`);
    await page.waitFor("document.querySelector('#healthText').textContent.includes('Hub online')", { timeout: 15_000, label: 'Health-Anzeige' });
    return title;
  });

  await check('Kennzahlen und Routenleiste sind gefuellt', async () => {
    await page.waitFor("Number(document.querySelector('#metricRoutes').textContent) > 0 && document.querySelectorAll('#routeList .route-row').length > 0", { timeout: 15_000, label: 'Routen-Kachel und Routenliste' });
    const snap = await page.evaluate(`
      return {
        routes: Number(document.querySelector('#metricRoutes').textContent),
        agents: Number(document.querySelector('#metricAgents').textContent),
        active: Number(document.querySelector('#metricRunning').textContent),
        completed: Number(document.querySelector('#metricDone').textContent),
        routeRows: document.querySelectorAll('#routeList .route-row').length,
        stats: (document.querySelector('.stats-row').textContent || '').trim()
      };`);
    if (!snap.routeRows) throw new Error('Routenliste ist leer');
    if (!snap.stats) throw new Error('Statistik-Leiste bleibt leer');
    return `${snap.routes} Routen, ${snap.routeRows} Routen-Einträge, ${snap.agents} Agenten, ${snap.active} aktiv, ${snap.completed} erledigt`;
  });

  await safeShot('01-uebersicht-desktop');

  await check('Villa per UI anlegen oeffnet den Arbeitsbereich', async () => {
    await page.evaluate("document.querySelector('#dashboardNewBtn').click(); return true;");
    await page.waitFor("document.querySelector('#createSheet').hidden === false", { timeout: 5_000, label: 'Formular zum Erstellen' });
    await page.evaluate(`
      document.querySelector('#villaName').value = 'Live-Test Villa';
      document.querySelector('#idea').value = ${JSON.stringify(VILLA_IDEA)};
      return true;`);
    await page.evaluate("document.querySelector('#createBtn').click(); return true;");
    await page.waitFor("document.querySelectorAll('#villaList .villa-card').length > 0", { timeout: 90_000, label: 'Villa-Kachel' });
    await page.waitFor("document.querySelector('#detailPanel').hidden === false", { timeout: 30_000, label: 'Arbeitsbereich offen' });
    villaId = await page.evaluate("return Number(document.querySelector('#villaList .villa-card').dataset.id);");
    const name = await page.evaluate("return document.querySelector('#dName').textContent;");
    if (!villaId) throw new Error('Keine Villa-ID gefunden');
    return `Villa #${villaId} „${name}"`;
  });

  await check('Arbeitsbereich zeigt Agenten, Aufgaben und Fortschritt', async () => {
    const snap = await page.evaluate(`
      return {
        stats: document.querySelectorAll('#dStats .stat').length,
        agents: Number(document.querySelector('#agentCountLabel').textContent),
        tasks: Number(document.querySelector('#taskCount').textContent),
        agentRows: document.querySelectorAll('#agentList .row').length,
        progress: document.querySelector('#progressLabel').textContent
      };`);
    if (snap.stats !== 3) throw new Error(`Unerwartete Kennzahlen: ${snap.stats} statt 3`);
    if (!snap.agents) throw new Error('Keine Agenten im Pool');
    if (!snap.tasks) throw new Error('Kein Aufgabenplan');
    if (!snap.agentRows) throw new Error('Agentenliste bleibt leer');
    return `${snap.agents} Agenten, ${snap.tasks} Aufgaben, ${snap.progress}`;
  });

  await safeShot('02-arbeitsbereich-chat');

  await check('Alle Arbeitsbereich-Tabs schalten um und sind gefuellt', async () => {
    const report = [];
    for (const tab of ['tasks', 'agents', 'reports', 'memory', 'audit']) {
      await page.evaluate(`document.querySelector('.tab-chip[data-tab="${tab}"]').click(); return true;`);
      await delay(600);
      const state = await page.evaluate(`
        const pane = document.querySelector('.workspace-main .tabpane[data-pane="${tab}"]');
        const list = pane?.querySelector('.list');
        return { active: !!pane?.classList.contains('active'), html: (list ? list.innerHTML : '').trim().length };`);
      if (!state.active) throw new Error(`Tab ${tab} wurde nicht aktiv`);
      if (!state.html) throw new Error(`Tab ${tab} ist leer`);
      report.push(`${tab}:${state.html}b`);
    }
    await page.evaluate("document.querySelector('.tab-chip[data-tab=\"chat\"]').click(); return true;");
    return report.join(' ');
  });

  await safeShot('03-tab-agenten');

  await check('Chat antwortet (Offline-Planer) und schreibt beide Seiten ins Protokoll', async () => {
    const before = await page.evaluate("return document.querySelectorAll('#chatLog .bubble').length;");
    await page.evaluate(`
      document.querySelector('#chatMsg').value = 'Nenne den naechsten konkreten Schritt als Liste.';
      document.querySelector('#sendBtn').click();
      return true;`);
    await page.waitFor(`document.querySelectorAll('#chatLog .bubble.assistant').length >= 1 &&
      !document.querySelector('#chatLog .bubble.assistant:last-child').textContent.includes('denkt')`,
      { timeout: 90_000, label: 'Antwort des Agents' });
    const out = await page.evaluate(`
      const bubbles = [...document.querySelectorAll('#chatLog .bubble')];
      const last = bubbles[bubbles.length - 1];
      return { count: bubbles.length, last: last.textContent.slice(0, 140), user: bubbles.some(b => b.classList.contains('user')) };`);
    if (out.count <= before) throw new Error('Keine neuen Chat-Blasen');
    if (!out.user) throw new Error('Eigene Nachricht fehlt im Protokoll');
    return `${out.count} Blasen · „${out.last.replace(/\s+/g, ' ')}"`;
  });

  await safeShot('04-chat-antwort');

  await check('Entwicklung startet und laesst sich stoppen', async () => {
    await page.evaluate("document.querySelector('#startBtn').click(); return true;");
    await page.waitFor("document.querySelector('#stopBtn').hidden === false", { timeout: 45_000, label: 'Lauf gestartet' });
    const running = await page.evaluate("return document.querySelector('#workspaceStatus').textContent;");
    await page.evaluate("document.querySelector('#stopBtn').click(); return true;");
    await page.waitFor("document.querySelector('#startBtn').hidden === false", { timeout: 45_000, label: 'Lauf gestoppt' });
    return `Status „${running}" → gestoppt`;
  });

  await check('Aufgabenliste zeigt den konkreten Projektplan', async () => {
    await page.evaluate("document.querySelector('.tab-chip[data-tab=\"tasks\"]').click(); return true;");
    const snap = await page.evaluate(`
      return {
        expected: Number(document.querySelector('#taskCount').textContent),
        visible: document.querySelectorAll('#taskList .row').length,
        empty: !!document.querySelector('#taskList .empty-state')
      };`);
    if (snap.expected < 1 || snap.visible < 1 || snap.empty) throw new Error(`Aufgaben nicht sichtbar: ${snap.visible}/${snap.expected}`);
    return `${snap.visible} Aufgaben sichtbar, ${snap.expected} im Plan`;
  });

  await check('Live-Ereignisse (SSE) sind verbunden', async () => {
    const streams = [...page.requests.values()].filter((r) => r.url.includes('/api/events'));
    if (!streams.length) throw new Error('Keine SSE-Verbindung aufgebaut');
    return `${streams.length} Stream(s), Status ${streams.map((s) => s.status).join('/')}`;
  });

  await check('Keine roten Antworten aus der API', async () => {
    const bad = [...page.requests.values()].filter((r) => r.status >= 500);
    if (bad.length) throw new Error(bad.map((b) => `${b.status} ${b.url}`).join(', '));
    const total = page.requests.size;
    return `${total} Anfragen, keine 5xx`;
  });

  await check('Konsole bleibt ohne Fehler', async () => {
    const hard = page.errors.filter((e) => !/favicon/i.test(e.text || ''));
    if (hard.length) throw new Error(hard.map((e) => e.text).join(' | ').slice(0, 300));
    return `${page.logs.length} Meldungen, ${page.errors.length} Fehler`;
  });

  await check('Keine abgebrochenen Netzwerkanfragen', async () => {
    if (page.failedRequests.length) throw new Error(page.failedRequests.map((f) => `${f.url} (${f.error})`).join(', '));
    return 'alle Anfragen sauber';
  });

  await check('Mobile Ansicht (390x844) bleibt bedienbar', async () => {
    await page.evaluate(`
      document.querySelector('#closeDetail').click();
      document.querySelector('.bottomnav .nav-item[data-view="home"]').click();
      return true;`);
    await delay(300);
    await page.setViewport(390, 844, { mobile: true });
    await delay(900);
    const snap = await page.evaluate(`
      const overflowX = document.documentElement.scrollWidth - window.innerWidth;
      const card = document.querySelector('#villaList .villa-card');
      const create = document.querySelector('#dashboardNewBtn');
      return {
        overflowX,
        homeVisible: document.querySelector('#view-home').classList.contains('active'),
        workspaceClosed: document.querySelector('#detailPanel').hidden,
        hasVilla: !!card,
        createBtnHeight: create ? Math.round(create.getBoundingClientRect().height) : 0
      };`);
    await safeShot('05-mobile-uebersicht');
    if (snap.overflowX > 2) throw new Error(`Horizontales Ueberlaufen: ${snap.overflowX}px`);
    if (!snap.homeVisible || !snap.workspaceClosed) throw new Error('Die mobile Übersicht wird nicht angezeigt');
    if (!snap.hasVilla) throw new Error('Villen-Kachel fehlt in der mobilen Ansicht');
    if (snap.createBtnHeight < 44) throw new Error(`Touch-Ziel zu klein: ${snap.createBtnHeight}px`);
    return `kein Ueberlauf, Touch-Ziel ${snap.createBtnHeight}px`;
  });

  await check('Mobiler Arbeitsbereich nutzt die volle Hoehe', async () => {
    await page.evaluate("document.querySelector('#villaList .villa-card').click(); return true;");
    await page.waitFor("document.querySelector('#detailPanel').hidden === false", { timeout: 30_000, label: 'Arbeitsbereich mobil' });
    await delay(600);
    const snap = await page.evaluate(`
      const panel = document.querySelector('#detailPanel').getBoundingClientRect();
      const workspace = document.querySelector('.workspace-main').getBoundingClientRect();
      return {
        panelH: Math.round(panel.height), workspaceH: Math.round(workspace.height),
        viewportH: window.innerHeight,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        tabs: document.querySelectorAll('#detailPanel .tab-chip').length
      };`);
    await safeShot('06-mobile-arbeitsbereich');
    if (snap.overflowX > 2) throw new Error(`Horizontales Ueberlaufen: ${snap.overflowX}px`);
    if (snap.panelH < Math.round(snap.viewportH * 0.9) || snap.workspaceH < 180) throw new Error('Arbeitsbereich nutzt die Hoehe nicht');
    if (snap.tabs < 6) throw new Error(`Nur ${snap.tabs} Tabs sichtbar`);
    return `${snap.panelH}px hoch, ${snap.tabs} Tabs, kein Ueberlauf`;
  });

  await page.setViewport(1440, 960);
  await page.navigate(`http://127.0.0.1:${PORT}/`);
  await delay(700);
  await safeShot('07-uebersicht-zurueck-desktop');
}

async function teardown() {
  try { page?.close(); } catch { /* egal */ }
  try { chrome?.stop(); } catch { /* egal */ }
  try { hub?.kill('SIGTERM'); } catch { /* egal */ }
  await delay(400);
  try { hub?.kill('SIGKILL'); } catch { /* egal */ }
  try { await modelMock?.close(); } catch { /* Prozess bereits beendet */ }
  if (workDir && !KEEP) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* egal */ } }
}

function writeReport() {
  mkdirSync(OUT_DIR, { recursive: true });
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail');
  const report = {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    hub_port: PORT,
    villa_id: villaId,
    summary: { total: results.length, passed, failed: failed.length, skipped: results.filter((r) => r.status === 'skip').length },
    console: { logs: page?.logs?.slice(-50) || [], errors: page?.errors || [] },
    network: {
      failed: page?.failedRequests || [],
      requests: [...(page?.requests?.values() || [])].map((r) => ({ status: r.status, type: r.type, url: r.url.replace(`http://127.0.0.1:${PORT}`, '') }))
    },
    steps: results
  };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

(async () => {
  console.log(`\nVillaForge Live-E2E · Hub-Port ${PORT}\n${'-'.repeat(60)}`);
  let report;
  try {
    await run();
  } catch (err) {
    step('Ablauf abgebrochen').fail(err);
  } finally {
    report = writeReport();
    await teardown();
  }
  const { passed, total, failed } = report.summary;
  console.log(`${'-'.repeat(60)}`);
  console.log(`${failed ? '\u2716' : '\u2714'} ${passed}/${total} Pruefungen bestanden · Report: ${join(OUT_DIR, 'report.json')}`);
  for (const f of report.steps.filter((s) => s.status === 'fail')) console.log(`   \u2716 ${f.name}: ${f.note}`);
  if (report.console.errors.length) console.log(`   ! Konsolenfehler: ${report.console.errors.length}`);
  process.exit(failed ? 1 : 0);
})();
