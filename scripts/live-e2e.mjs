#!/usr/bin/env node
/**
 * VillaForge Live-E2E: faehrt den echten Hub in einem echten Chrome durch.
 *
 * Der Test startet eine eigene Hub-Instanz (eigene Datenbank, eigener
 * Workspace, ohne LLM-Keys -> Offline-Planer), oeffnet die Web-Oberflaeche in
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
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    VF_DB: join(workDir, 'hub.db'),
    VF_WORKSPACE: join(workDir, 'workspace'),
    VF_LOG_FILE: join(workDir, 'hub.log'),
    VF_RESUME: '0'
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
    await page.waitFor("Number(document.querySelector('#metricRoutes').textContent) > 0", { timeout: 15_000, label: 'Routen-Kachel' });
    const snap = await page.evaluate(`
      return {
        routes: Number(document.querySelector('#metricRoutes').textContent),
        villas: Number(document.querySelector('#metricVillas').textContent),
        routeRows: document.querySelectorAll('#routeList .row').length,
        stats: (document.querySelector('#statsBar').textContent || '').trim()
      };`);
    if (!snap.routeRows) throw new Error('Routenliste ist leer');
    if (!snap.stats) throw new Error('Statistik-Leiste bleibt leer');
    return `${snap.routes} Routen, ${snap.routeRows} Zeilen, Statistik: ${snap.stats.slice(0, 60)}…`;
  });

  await safeShot('01-uebersicht-desktop');

  let villaId = null;
  await check('Villa per UI anlegen oeffnet den Arbeitsbereich', async () => {
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
    if (snap.stats < 4) throw new Error(`Nur ${snap.stats} Kennzahlen-Kacheln`);
    if (!snap.agents) throw new Error('Keine Agenten im Pool');
    if (!snap.tasks) throw new Error('Kein Aufgabenplan');
    if (!snap.agentRows) throw new Error('Agentenliste bleibt leer');
    return `${snap.agents} Agenten, ${snap.tasks} Aufgaben, ${snap.progress}`;
  });

  await safeShot('02-arbeitsbereich-chat');

  await check('Alle Arbeitsbereich-Tabs schalten um und sind gefuellt', async () => {
    const report = [];
    for (const tab of ['tasks', 'agents', 'packs', 'reports', 'memory', 'audit']) {
      await page.evaluate(`document.querySelector('.side-tab[data-tab="${tab}"]').click(); return true;`);
      await delay(600);
      const state = await page.evaluate(`
        const pane = document.querySelector('.workspace-main .tabpane[data-pane="${tab}"]');
        const list = pane.querySelector('.list, .tabpane');
        return { active: pane.classList.contains('active'), html: (list ? list.innerHTML : '').trim().length };`);
      if (!state.active) throw new Error(`Tab ${tab} wurde nicht aktiv`);
      if (!state.html) throw new Error(`Tab ${tab} ist leer`);
      report.push(`${tab}:${state.html}b`);
    }
    await page.evaluate("document.querySelector('.side-tab[data-tab=\"chat\"]').click(); return true;");
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

  await check('Aufgabenfilter arbeitet ohne Fehler', async () => {
    const counts = {};
    for (const value of ['', 'PENDING', 'FAILED']) {
      counts[value || 'ALLE'] = await page.evaluate(`
        const f = document.querySelector('#taskFilter');
        f.value = ${JSON.stringify(value)};
        f.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 250));
        return document.querySelectorAll('#taskList .row').length;`);
    }
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!sum) throw new Error('Filter zeigt in keiner Ansicht Aufgaben');
    return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
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

  await check('Arbeitsbereich: Reiter per Tastatur und Fokus wiederherstellen', async () => {
    await page.evaluate(`const tab = document.querySelector('.side-tab[data-tab="chat"]'); tab.click(); tab.focus(); return true;`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    const keyboard = await page.evaluate(`return document.activeElement.dataset.tab === 'tasks' && document.querySelector('.dashboard').inert;`);
    if (!keyboard) throw new Error('Tastaturreiter oder Hintergrund-Isolation fehlen');
    await page.evaluate(`document.querySelector('#closeDetail').click(); return true;`);
    const restored = await page.evaluate(`return !document.querySelector('.dashboard').inert && document.activeElement.getClientRects().length > 0;`);
    if (!restored) throw new Error('Fokus geht beim Schließen verloren');
    return 'Pfeiltasten, isolierter Hintergrund und sichtbarer Fokus';
  });
  await check('Villen-Suche, Leerzustand und Filter-Reset', async () => {
    const empty = await page.evaluate(`const search = document.querySelector('#villaSearch'); search.value = 'kein-treffer-999'; search.dispatchEvent(new Event('input')); return document.querySelectorAll('.villa-card').length === 0 && !!document.querySelector('.empty-action');`);
    if (!empty) throw new Error('Suche filtert nicht');
    const reset = await page.evaluate(`document.querySelector('.empty-action').click(); return document.querySelector('#villaSearch').value === '' && document.querySelectorAll('.villa-card').length > 0;`);
    if (!reset) throw new Error('Filter-Reset stellt Liste nicht wieder her');
    return 'Suche und Reset funktionieren';
  });

  await check('Mobile Ansicht (390x844) bleibt bedienbar', async () => {
    await page.setViewport(390, 844, { mobile: true });
    await page.navigate(`http://127.0.0.1:${PORT}/`);
    await delay(900);
    const snap = await page.evaluate(`
      const overflowX = document.documentElement.scrollWidth - window.innerWidth;
      const card = document.querySelector('#villaList .villa-card');
      return {
        overflowX,
        hasVilla: !!card,
        chatVisible: !!document.querySelector('#heroCreateBtn'),
        createBtnHeight: Math.round(document.querySelector('#heroCreateBtn').getBoundingClientRect().height)
      };`);
    await safeShot('05-mobile-uebersicht');
    if (snap.overflowX > 2) throw new Error(`Horizontales Ueberlaufen: ${snap.overflowX}px`);
    if (!snap.hasVilla) throw new Error('Villen-Kachel fehlt in der mobilen Ansicht');
    if (snap.createBtnHeight < 44) throw new Error(`Touch-Ziel zu klein: ${snap.createBtnHeight}px`);
    return `kein Ueberlauf, Touch-Ziel ${snap.createBtnHeight}px`;
  });

  await check('Mobiler Arbeitsbereich nutzt die volle Hoehe', async () => {
    await page.evaluate("document.querySelector('#villaList .villa-card').click(); return true;");
    await page.waitFor("document.querySelector('#detailPanel').hidden === false", { timeout: 30_000, label: 'Arbeitsbereich mobil' });
    await delay(600);
    const tabVisible = await page.evaluate(`const rect = document.querySelector('.side-tab[data-tab="chat"]').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;`);
    if (!tabVisible) throw new Error('Primärer Chat-Reiter ist auf Mobilgeräten nicht sichtbar');
    const snap = await page.evaluate(`
      const shell = document.querySelector('.workspace-shell').getBoundingClientRect();
      const panel = document.querySelector('#detailPanel').getBoundingClientRect();
      return {
        shellH: Math.round(shell.height), panelH: Math.round(panel.height),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        tabs: document.querySelectorAll('.side-tab').length
      };`);
    await safeShot('06-mobile-arbeitsbereich');
    if (snap.overflowX > 2) throw new Error(`Horizontales Ueberlaufen: ${snap.overflowX}px`);
    if (snap.shellH < Math.round(snap.panelH * 0.98)) throw new Error('Arbeitsbereich nutzt die Hoehe nicht');
    if (snap.tabs < 6) throw new Error(`Nur ${snap.tabs} Tabs sichtbar`);
    return `${snap.panelH}px hoch, ${snap.tabs} Tabs, kein Ueberlauf`;
  });

  await page.setViewport(1440, 960);
  await page.navigate(`http://127.0.0.1:${PORT}/`);
  await delay(700);
  await safeShot('07-uebersicht-zurueck-desktop');
  await check('Master-Chat: Status und Villa mit Prompt erstellen', async () => {
    await page.evaluate("document.querySelector('#masterOpenBtn').click(); return true;");
    await page.waitFor("document.querySelector('#masterDialog').open && document.querySelector('#masterSummary').textContent.includes('Villen')", {timeout:15000});
    await page.evaluate("document.querySelector('#masterInput').value='Status'; document.querySelector('#masterForm').requestSubmit(); return true;");
    await page.waitFor("document.querySelector('#masterLog').textContent.includes('sichtbare Villen') && !document.querySelector('#masterSendBtn').disabled", {timeout:15000});
    await page.evaluate(`document.querySelector('#masterInput').value='Erstelle Villa "Master Browser": Ein überprüfbarer Projektauftrag'; document.querySelector('#masterForm').requestSubmit(); return true;`);
    await page.waitFor("document.querySelector('#masterLog').textContent.includes('mit Projektauftrag angelegt') && !document.querySelector('#masterSendBtn').disabled",{timeout:90000});
    await safeShot('08-master-desktop');
    await page.setViewport(390,844);
    await delay(200);
    const overflow=await page.evaluate('return document.documentElement.scrollWidth-window.innerWidth;');
    if(overflow>2) throw new Error(`Master überläuft um ${overflow}px`);
    await safeShot('09-master-mobile');
    await page.evaluate("document.querySelector('#masterCloseBtn').click(); return true;");
    return 'Status, dauerhafter Verlauf und echte Villa-Erstellung; Desktop und Mobil';
  });

}

async function teardown() {
  try { page?.close(); } catch { /* egal */ }
  try { chrome?.stop(); } catch { /* egal */ }
  try { hub?.kill('SIGTERM'); } catch { /* egal */ }
  await delay(400);
  try { hub?.kill('SIGKILL'); } catch { /* egal */ }
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
    villa_id: results.length ? null : null,
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

