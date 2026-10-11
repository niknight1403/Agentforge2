/**
 * Gemeinsamer Hub-Start fuer Live-Tests und Design-Audit.
 *
 * Startet eine vollstaendig isolierte Hub-Instanz: eigene SQLite-Datei,
 * eigener Workspace, eigene Logdatei und bewusst KEINE LLM-Schluessel —
 * damit ein Lauf reproduzierbar bleibt und nie versehentlich echte Kontingente
 * verbraucht. Der Offline-Planer muss den Test allein tragen.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');

const KEY_PATTERN = /^(GROQ|GEMINI|CEREBRAS|MISTRAL|TOGETHER|OPENROUTER|DEEPSEEK|XAI|PERPLEXITY)_API_KEY/;

/** Wartet, bis eine Funktion true liefert (oder die Frist ablaeuft). */
export async function waitUntil(fn, { timeout = 30_000, interval = 150, label = 'Bedingung' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (err) { lastError = err; }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`${label} nicht erreicht nach ${timeout}ms${lastError ? ` (${lastError.message})` : ''}`);
}

/**
 * @returns {Promise<{port:number, health:object, dir:string, log:string, stop:()=>Promise<void>}>}
 */
export async function startHub({ port, host = '127.0.0.1', env = {}, keep = false, verbose = false } = {}) {
  const chosenPort = port || 12000 + Math.floor(Math.random() * 400);
  const dir = mkdtempSync(join(tmpdir(), 'vf-live-'));
  const childEnv = {
    ...process.env,
    ...env,
    PORT: String(chosenPort),
    HOST: host,
    VF_DB: join(dir, 'hub.db'),
    VF_WORKSPACE: join(dir, 'workspace'),
    VF_LOG_FILE: join(dir, 'hub.log'),
    VF_RESUME: '0'
  };
  for (const key of Object.keys(childEnv)) if (KEY_PATTERN.test(key)) delete childEnv[key];

  const proc = spawn(process.execPath, ['server/server.mjs'], {
    cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (verbose) {
    proc.stdout.on('data', (d) => process.stdout.write(`[hub] ${d}`));
    proc.stderr.on('data', (d) => process.stdout.write(`[hub:err] ${d}`));
  }

  const base = `http://${host}:${chosenPort}`;
  let health;
  await waitUntil(async () => {
    if (proc.exitCode != null) throw new Error(`Hub beendet sich sofort (Code ${proc.exitCode})`);
    const res = await fetch(`${base}/api/health`);
    if (!res.ok) return false;
    health = await res.json();
    return true;
  }, { timeout: 30_000, label: 'Hub-Health' });

  return {
    port: chosenPort,
    base,
    health,
    dir,
    log: join(dir, 'hub.log'),
    pid: proc.pid,
    async stop() {
      try { proc.kill('SIGTERM'); } catch { /* schon weg */ }
      await new Promise((r) => setTimeout(r, 300));
      try { proc.kill('SIGKILL'); } catch { /* schon weg */ }
      if (!keep) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ } }
    }
  };
}
