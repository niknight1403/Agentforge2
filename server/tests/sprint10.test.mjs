/**
 * Sprint 10 (v1.40.0) — Sequenzielle Villen, Echter-Code-Tor, GitHub-Produkt-Repo.
 *
 * 1) Villen laufen strikt nacheinander (Scheduler-Default: 1 Slot, alle
 *    Startstellen laufen ueber scheduleVilla statt Direkt-orchestrate).
 * 2) Das Qualitaetstor reisst bei leerem Projektordner: Aufgaben muessen
 *    echte Dateien (code_write) liefern, keine Berichte.
 * 3) publishToGitHub legt pro Villa das passende Produkt-Repo an und pusht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 's10-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { db, now } = await import('../db.mjs');
const { WORKSPACE, villaProjectDir, setSource, sourceRoot, runTool, runQualityGate, publishToGitHub } = await import('../agents.mjs');
const { setPackEnabled } = await import('../packs.mjs');
const { schedulerStatus } = await import('../scheduler.mjs');

const t = now();
db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES ('AI Marketplace','AOCS-EW Plugin-Marktplatz','CREATED',10,1,?,?)").run(t, t);
const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);

test('Scheduler: mindestens 3 Villen parallel und alle Startstellen ueber scheduleVilla', () => {
  assert.ok(schedulerStatus().slots >= 3, 'drei Villen muessen parallel startbar sein');
  const srv = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.ok(!/[^A-Za-z.]orchestrate\(/.test(srv.replace(/scheduleVilla\(/g, '')), 'server.mjs startet keine Villa direkt');
  const sched = readFileSync(new URL('../scheduler.mjs', import.meta.url), 'utf8');
  assert.ok(sched.includes('VF_VILLA_SLOTS ?? 3'), 'Slot-Default 3');
  assert.ok(sched.includes('export function scheduleVilla'), 'scheduleVilla exportiert');
});

test('code_write legt echte verschachtelte Dateien an und aktiviert den Projektordner', async () => {
  const out = await runTool({ villaId, agentId: 1 }, 'code_write', { path: 'src/main.py', content: 'print("AOCS-EW")' });
  assert.match(out, /Codedatei geschrieben: src\/main\.py/);
  assert.ok(existsSync(join(villaProjectDir(villaId), 'src/main.py')));
  assert.equal(sourceRoot(villaId), villaProjectDir(villaId), 'Projektordner ist als Quelle aktiviert');
  const bad = await runTool({ villaId, agentId: 1 }, 'code_write', { path: '../evil.py', content: 'x' });
  assert.match(bad, /Ungueltiger Pfad/);
});

test('Tor reisst bei leerem Projektordner (Screenshot-Problem) und laesst echten Code durch', async () => {
  setPackEnabled('qualitaetstor', true);
  rmSync(villaProjectDir(villaId), { recursive: true, force: true });
  setSource(villaId, '');
  const empty = await runQualityGate(villaId, { title: 'Backbone bauen' }, 'Bericht ohne Code');
  assert.equal(empty.passed, false);
  assert.match(empty.output, /code_write/);
  assert.match(empty.output, /Projektordner ist leer/);
  // Echter Python-Code (Syntax ok) besteht das Tor
  await runTool({ villaId, agentId: 1 }, 'code_write', { path: 'main.py', content: 'print("ok")' });
  const py = await runQualityGate(villaId, { title: 'Backbone bauen' }, 'Umsetzung');
  assert.equal(py.passed, true, 'gültiges Python muss durch: ' + String(py.output).slice(0, 120));
  assert.match(py.annotated, /py_compile gruen/);
  // Kaputter Python-Code reisst das Tor
  await runTool({ villaId, agentId: 1 }, 'code_write', { path: 'broken.py', content: 'def oops(' });
  const bad = await runQualityGate(villaId, { title: 'Backbone bauen' }, 'Umsetzung');
  assert.equal(bad.passed, false, 'Syntaxfehler muss das Tor reissen');
});

test('publishToGitHub: Repo anlegen, committen, pushen (Token aus Secrets-Store)', async () => {
  // Ohne Token: klare Fehlermeldung, kein Absturz
  const noTok = await publishToGitHub(villaId, 1, { title: 'Produkt' });
  assert.equal(noTok.ok, false);
  assert.match(noTok.error, /Kein GITHUB_TOKEN/);
  db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('GITHUB_TOKEN','gh-test-token',0)").run();
  const cmds = [];
  const fakeExec = (cmd) => { cmds.push(cmd); return null; };
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/user')) return new Response(JSON.stringify({ login: 'niknight1403' }), { status: 200 });
    if (String(url).endsWith('/user/repos') && init?.method === 'POST') return new Response(JSON.stringify({ full_name: 'x' }), { status: 201 });
    throw new Error('unerwartet: ' + url);
  };
  const r = await publishToGitHub(villaId, 1, { title: 'AI Marketplace: Backbone' }, { exec: fakeExec, fetchFn: fakeFetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.repo, 'niknight1403/villaforge-ai-marketplace');
  assert.equal(r.url, 'https://github.com/niknight1403/villaforge-ai-marketplace');
  const create = calls.find((c) => c.init?.method === 'POST');
  assert.equal(JSON.parse(create.init.body).name, 'villaforge-ai-marketplace');
  const push = cmds.find((c) => c.includes(' push '));
  assert.ok(push.includes('x-access-token:gh-test-token@github.com/niknight1403/villaforge-ai-marketplace.git'), 'Push-Ziel mit Token');
  assert.ok(cmds.some((c) => c.includes(' commit ')), 'Commit vor Push');
  assert.ok(cmds.some((c) => c.includes('.gitignore') || c.includes('add -A')), 'gitignore/Add Schritt');
});

test('executeTask pusht nach gruenem Tor automatisch ins Produkt-Repo', () => {
  const src = readFileSync(new URL('../agents.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('const pub = await publishToGitHub(villaId, agent.id, task)'), 'Auto-Push vorhanden');
  assert.ok(src.includes("status: 'PUSHED'"), 'PUSHED-Event vorhanden');
});
