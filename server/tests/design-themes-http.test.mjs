import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vf-themes-api-'));
const dbPath = join(dir, 'hub.db');
const port = 37000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let child;

before(async () => {
  process.env.VF_DB = dbPath;
  process.env.VF_WORKSPACE = join(dir, 'work');
  child = spawn(process.execPath, ['server/server.mjs'], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, VF_DB: dbPath, VF_WORKSPACE: join(dir, 'work'), HOST: '127.0.0.1', PORT: String(port), VF_RESUME: '0', VF_OPEN_MODE: '1', VF_RATE_WAIT_MS: '1' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Hub startup failed');
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 1500).unref(); });
  }
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/design/themes liefert ohne eigene Themes eine leere Liste', async () => {
  const response = await fetch(`${base}/api/design/themes`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.themes, []);
});

test('Ein selbst angelegtes Theme erscheint am Endpunkt und die Oberflaeche bietet den Skip-Link', async () => {
  const { upsertTheme } = await import('../control-store.mjs');
  const saved = upsertTheme({ id: 'Mein Theme 2026', title: 'Mein Theme', colors: { bg: '#0A0B0C', cyan: '#00E5FF' }, activate: true });
  assert.equal(saved.id, 'mein-theme-2026');

  const body = await (await fetch(`${base}/api/design/themes`)).json();
  assert.equal(body.themes.length, 1);
  assert.equal(body.themes[0].id, 'mein-theme-2026');
  assert.deepEqual(body.themes[0].colors, { bg: '#0a0b0c', cyan: '#00e5ff' });

  const html = await (await fetch(`${base}/index.html`)).text();
  assert.match(html, /class="skip-link"/);
  assert.match(html, /Zum Inhalt springen/);
  const css = await (await fetch(`${base}/styles.css`)).text();
  assert.match(css, /\.skip-link:focus/);
});
