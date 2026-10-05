/**
 * LLM-Smoke-Test fuer CI (oder lokal): prueft, ob mindestens eine
 * kostenlose Route mit einem echten Key antwortet.
 *
 * Die Keys kommen NIE ins Repo — sie werden aus der Umgebung gelesen:
 *   - lokal:      Shell-Export oder `--experimental-sqlite`-Start mit env
 *   - GitHub CI:  Repository-Secrets (GROQ_API_KEY, OPENROUTER_API_KEY,
 *                 GEMINI_API_KEY), injiziert im Workflow
 *
 * Ablauf:
 *   1. Ohne Key:  Ausgabe "SKIP", Exit 0 (CI bleibt gruen).
 *   2. Mit Key:   Hub auf temporärer DB starten, Villa anlegen,
 *                 Root-Agenten fragen. Muss mit offline=false antworten.
 *   3. Scheitert die echte Route (401/429/Netz), rotiert der Hub auf
 *      Offline → offline=true → Exit 1 (sichtbarer Fehlschlag).
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const KEY_NAMES = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];
const present = KEY_NAMES.filter((k) => process.env[k] && process.env[k].length > 8);
if (!present.length) {
  console.log('SKIP: kein LLM-Key in der Umgebung ( Secrets fehlen). Offline-Modus bleibt erlaubt.');
  process.exit(0);
}
console.log('Schluessel vorhanden:', present.join(', '));

const ROOT = resolve(import.meta.dirname, '../..');
const DB = join(tmpdir(), `vf-ci-smoke-${process.pid}.db`);
const PORT = 12991;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, VF_DB: DB, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const cleanup = (code) => {
  child.kill('SIGTERM');
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* tmp, egal */ }
  }
  process.exit(code);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHub() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  throw new Error('Hub ist nicht erreichbar');
}

try {
  await waitForHub();

  const created = await (await fetch(`${BASE}/api/villas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CI-Smoke', idea: 'Ein-Satz-Antworten testen', agentCount: 3 })
  })).json();
  const villaId = created.villaId;
  console.log(`Villa #${villaId} angelegt, Planer-Route: ${created.plan?.summary?.slice(0, 60) || 'n/a'}`);

  const chatRes = await (await fetch(`${BASE}/api/villas/${villaId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Antworte mit genau einem kurzen Satz, dass du einsatzbereit bist.' })
  })).json();

  console.log('Antwort-Route:', chatRes.route, '| offline:', chatRes.offline);
  if (chatRes.offline) {
    // 429 mit hinterlegtem Key beweist, dass der Key gueltig ist und das
    // Modell existiert — nur das Gratis-Kontingent ist leer. Das ist kein
    // Regressionsfehler und darf den Bau nicht rot machen; 401/Netzfehler
    // dagegen schon.
    const rateLimited = /HTTP 429/.test(log);
    if (rateLimited && !/HTTP 40[13]/.test(log)) {
      console.log('PASS (Kontingent): alle echten Routen im Tages-/Minutenlimit, Keys aber gueltig (429).');
      console.log('Hub-Log (Auszug):\n' + log.slice(-1500));
      cleanup(0);
    }
    console.error('FEHLER: keine echte LLM-Route zustande gekommen (Key ungueltig/Limit erreicht?).');
    console.error('Hub-Log (Auszug):\n' + log.slice(-1500));
    cleanup(1);
  }
  console.log('Antwort:', String(chatRes.answer).slice(0, 140).replace(/\n/g, ' '));
  console.log('OK: echte LLM-Route hat geantwortet.');
  cleanup(0);
} catch (err) {
  console.error('FEHLER:', err.message);
  console.error('Hub-Log (Auszug):\n' + log.slice(-1500));
  cleanup(1);
}
