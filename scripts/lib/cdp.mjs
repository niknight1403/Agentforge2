/**
 * Mini-Client fuer das Chrome DevTools Protocol (CDP) — ohne externe Pakete.
 *
 * Warum eigener Client: VillaForge hat bewusst null npm-Abhaengigkeiten. Ein
 * echter Browser-Test (Playwright/Puppeteer) wuerde den Hub mit hunderten
 * Fremdpaketen belasten. Chrome selbst ist auf jedem Entwickler- und CI-Rechner
 * vorhanden (`chrome`, `chromium` oder `google-chrome`); gesprochen wird ueber
 * die eingebaute WebSocket-Implementierung von Node (>= 22).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const CANDIDATES = [
  process.env.VF_CHROME,
  'chrome',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  '/usr/local/bin/chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Liegt eine ausfuehrbare Datei dieses Namens im PATH? */
function onPath(name) {
  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, name)));
}

/**
 * Findet einen Chrome/Chromium. Wichtig: einen relativen Namen NICHT blind
 * zurueckgeben — sonst startet der Test auf Rechnern ohne "chrome" im PATH
 * mit einem irrefuehrenden ENOENT statt mit dem naechsten Kandidaten.
 */
export function resolveChrome() {
  for (const c of CANDIDATES) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
    } else if (onPath(c)) {
      return c;
    }
  }
  return 'chrome'; // letzter Versuch: spawn meldet dann einen klaren Fehler
}

/**
 * Startet Chrome headless mit offenem DevTools-Port und wartet, bis der
 * Debug-Endpunkt antwortet. Gibt Handle mit stop() zurueck.
 */
export async function launchChrome({ port = 9333, width = 1440, height = 960, chrome = resolveChrome(), extraArgs = [] } = {}) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    ...extraArgs,
    'about:blank'
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += String(d); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let version = null;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) throw new Error(`Chrome beendet (Code ${proc.exitCode}): ${stderr.slice(-400)}`);
    try {
      const res = await fetch(`${base}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* noch nicht bereit */ }
    await delay(120);
  }
  if (!version) {
    proc.kill('SIGKILL');
    throw new Error(`Chrome DevTools nicht erreichbar auf Port ${port}. ${stderr.slice(-400)}`);
  }

  return {
    port,
    base,
    version,
    pid: proc.pid,
    stop() {
      try { proc.kill('SIGTERM'); } catch { /* schon weg */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* schon weg */ } }, 1500).unref?.();
    }
  };
}

/** Neuen Tab oeffnen und dessen Debug-URL liefern (PUT ab Chrome 111). */
export async function newTarget(base, url = 'about:blank') {
  let res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`Tab konnte nicht geoeffnet werden (HTTP ${res.status})`);
  return res.json();
}

/** Eine bestehende Seite ueber ihre webSocketDebuggerUrl steuern. */
export class Page {
  #ws; #seq = 0; #pending = new Map(); #listeners = []; #closed = false;
  logs = []; errors = []; requests = new Map(); failedRequests = [];

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket-Timeout')), 15_000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket-Fehler')); };
    });
    const page = new Page(ws);
    page.#wire();
    return page;
  }

  constructor(ws) { this.#ws = ws; }

  get connected() { return !this.#closed; }

  #wire() {
    this.#ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      this.#record(msg);
      for (const fn of this.#listeners) fn(msg);
    };
    this.#ws.onclose = () => { this.#closed = true; };
  }

  /** Konsole, Ausnahmen und Netzwerk dauerhaft mitschreiben. */
  #record(msg) {
    const p = msg.params || {};
    if (msg.method === 'Runtime.consoleAPICalled') {
      this.logs.push({
        level: p.type,
        text: (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      this.errors.push({ kind: 'exception', text: d.exception?.description || d.text || 'unbekannte Ausnahme' });
    } else if (msg.method === 'Log.entryAdded') {
      const e = p.entry || {};
      if (e.level === 'error') this.errors.push({ kind: 'log', text: e.text, url: e.url });
      else this.logs.push({ level: e.level, text: e.text });
    } else if (msg.method === 'Network.requestWillBeSent') {
      this.requests.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, status: null });
    } else if (msg.method === 'Network.responseReceived') {
      const r = this.requests.get(p.requestId);
      if (r) { r.status = p.response.status; r.type = p.type; }
    } else if (msg.method === 'Network.loadingFailed') {
      const r = this.requests.get(p.requestId) || { url: p.requestId };
      // Abgebrochene Anfragen (z. B. SSE beim Schliessen) sind kein Fehler.
      if (!p.canceled) this.failedRequests.push({ url: r.url, error: p.errorText });
    }
  }

  on(fn) { this.#listeners.push(fn); return () => { this.#listeners = this.#listeners.filter((f) => f !== fn); }; }

  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('Verbindung geschlossen'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.has(id)) { this.#pending.delete(id); reject(new Error(`CDP-Timeout: ${method}`)); }
      }, 60_000).unref?.();
    });
  }

  /** Alle relevanten Domaenen aktivieren, damit nichts unbemerkt bleibt. */
  async enableAll() {
    for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'DOM.enable']) {
      try { await this.send(m); } catch { /* einzelne Domaene fehlt — egal */ }
    }
  }

  async navigate(url, { waitUntil = 'load', timeout = 30_000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.on((msg) => {
        if (msg.method === (waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired')) { off(); resolve(); }
      });
    });
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, delay(timeout)]);
    await delay(150);
  }

  /** Ausdruck im Seitenkontext auswerten (Promises werden aufgeloest). */
  async evaluate(expression, { timeout = 20_000 } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Auswertung fehlgeschlagen');
    }
    return res.result?.value;
  }

  /** Auf eine Bedingung in der Seite warten. */
  async waitFor(expression, { timeout = 20_000, interval = 150, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await this.evaluate(`return (${expression}) ? true : false;`); } catch { last = false; }
      if (last) return true;
      await delay(interval);
    }
    throw new Error(`Bedingung nicht erfuellt nach ${timeout}ms: ${label}`);
  }

  async setViewport(width, height, { mobile = false } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile,
      screenOrientation: { type: 'portraitPrimary', angle: 0 }
    });
  }

  async screenshot(path, { fullPage = false } = {}) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(res.data, 'base64'));
    return path;
  }

  close() { try { this.#ws.close(); } catch { /* schon zu */ } this.#closed = true; }
}

export { delay };
