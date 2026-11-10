/**
 * Issue #135 — Integrationen veroeffentlichen ueber Feature-Branch und Pull
 * Request. Kein Force-Push, kein Commit auf den Zielbranch, kein neues
 * Repository fuer eine gebundene Villa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'vf-integration-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { db, now } = await import('../db.mjs');
const { publishIntegration, integrationBranchName, redactSecrets, slugify } = await import('../integration-publish.mjs');
const { bindVillaRepo } = await import('../repo-target.mjs');
const { publishToGitHub } = await import('../agents.mjs');

/** Projektordner mit echtem .git-Verzeichnis, damit der Checkout-Guard greift. */
function checkoutDir(name) {
  const dir = mkdtempSync(join(tmp, `${name}-`));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'index.js'), 'export const ok = true;\n');
  return dir;
}

function addVilla(name, sourcePath) {
  const t = now();
  return Number(db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at, source_path, mode) VALUES (?,?,?,?,?,?,?)')
    .run(name, `Idee ${name}`, 'RUNNING', t, t, sourcePath, 'INTEGRATION').lastInsertRowid);
}

function recorder() {
  const cmds = [];
  return { cmds, exec: (cmd) => { cmds.push(cmd); return null; } };
}

function prFetch(response = { number: 12, html_url: 'https://github.com/o/r/pull/12' }, status = 201) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response), { status });
  };
  return { calls, fetchFn };
}

/* ---------------- Benennung und Redaktion ---------------- */

test('Feature-Branch ist deterministisch und branch-tauglich', () => {
  assert.equal(integrationBranchName(7, 'Chat-gesteuerter Dateimanager'), 'villaforge/integration-7-chat-gesteuerter-dateimanager');
  assert.equal(integrationBranchName(7, 'Chat-gesteuerter Dateimanager'), integrationBranchName(7, 'Chat-gesteuerter Dateimanager'));
  assert.equal(integrationBranchName(7), 'villaforge/integration-7');
  assert.equal(slugify('Über Änderungen / Tests!'), 'ber-nderungen-tests');
  assert.throws(() => integrationBranchName(0), /Ungueltige Villa-ID/);
});

test('Zugangsdaten werden aus Fehlertexten entfernt', () => {
  const dirty = 'fatal: https://x-access-token:ghp_abcdefghijklmnopqrstuv@github.com/o/r.git and ghp_abcdefghijklmnopqrstuv';
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes('ghp_abcdefghijklmnopqrstuv'));
  assert.match(clean, /x-access-token:\[redacted\]@/);
});

/* ---------------- Guards ---------------- */

test('Zielbranch kann nie Arbeitsbranch sein', async () => {
  const root = checkoutDir('guard');
  const { cmds, exec } = recorder();
  const result = await publishIntegration({
    villaId: 3, root, repo: 'o/r', baseBranch: 'main', featureBranch: 'main',
    title: 'Integration', message: 'Integration', token: 'ghp_testtoken123456', exec, fetchFn: async () => { throw new Error('kein Netz'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'guard');
  assert.deepEqual(cmds, [], 'vor jedem Git-Befehl abbrechen');
});

test('Ohne Token, ohne Checkout und mit ungueltigem Ziel wird nichts ausgefuehrt', async () => {
  const { cmds, exec } = recorder();
  const base = { villaId: 3, root: checkoutDir('noop'), repo: 'o/r', baseBranch: 'main', featureBranch: 'villaforge/integration-3', title: 'T', message: 'M', exec };

  const noToken = await publishIntegration({ ...base, token: '' });
  assert.equal(noToken.stage, 'config');
  const badRepo = await publishIntegration({ ...base, token: 'x', repo: 'kein repo' });
  assert.equal(badRepo.stage, 'config');
  const noGit = await publishIntegration({ ...base, root: mkdtempSync(join(tmp, 'plain-')), token: 'ghp_testtoken123456' });
  assert.equal(noGit.stage, 'checkout');
  assert.deepEqual(cmds, []);
});

test('Rotes Qualitaetstor verhindert Commit und Push', async () => {
  const { cmds, exec } = recorder();
  const result = await publishIntegration({
    villaId: 4, root: checkoutDir('gates'), repo: 'o/r', baseBranch: 'main',
    featureBranch: 'villaforge/integration-4', title: 'T', message: 'M',
    token: 'ghp_testtoken123456', exec, fetchFn: async () => { throw new Error('kein Netz'); },
    gates: async () => ({ passed: false, output: 'npm test: 3 failing' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'gates');
  assert.match(result.error, /Qualitaetstor/);
  assert.deepEqual(cmds, []);
});

test('Ohne Aenderungen entsteht kein Push und kein PR', async () => {
  const cmds = [];
  const exec = (cmd) => {
    cmds.push(cmd);
    return / commit /.test(cmd) ? 'nothing to commit, working tree clean' : null;
  };
  const { calls, fetchFn } = prFetch();
  const result = await publishIntegration({
    villaId: 5, root: checkoutDir('empty'), repo: 'o/r', baseBranch: 'main',
    featureBranch: 'villaforge/integration-5', title: 'T', message: 'M',
    token: 'ghp_testtoken123456', exec, fetchFn
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'commit');
  assert.match(result.error, /Keine Aenderungen/);
  assert.ok(!cmds.some((c) => c.includes(' push ')), 'kein Push ohne Commit');
  assert.equal(calls.length, 0, 'kein PR ohne Commit');
});

/* ---------------- Erfolgsweg ---------------- */

test('Erfolgsweg: Feature-Branch pushen und PR gegen den Zielbranch oeffnen', async () => {
  const { cmds, exec } = recorder();
  const { calls, fetchFn } = prFetch();
  const result = await publishIntegration({
    villaId: 42, root: checkoutDir('happy'), repo: 'https://github.com/niknight1403/Agentforge2.git',
    baseBranch: 'main', title: 'Integration: Dateimanager', message: 'Integration: Dateimanager',
    body: 'Beschreibung', token: 'ghp_testtoken123456', exec, fetchFn,
    gates: async () => ({ passed: true, output: 'Exit 0' })
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.repo, 'niknight1403/Agentforge2');
  assert.equal(result.base, 'main');
  assert.equal(result.feature, 'villaforge/integration-42-integration-dateimanager');
  assert.equal(result.number, 12);

  const push = cmds.find((c) => c.includes(' push '));
  assert.ok(push.includes('refs/heads/villaforge/integration-42-integration-dateimanager:refs/heads/villaforge/integration-42-integration-dateimanager'), 'explizites Refspec');
  assert.ok(!/--force|push -f/.test(push), 'niemals force');
  assert.ok(!push.includes(':refs/heads/main'), 'Zielbranch nicht im Refspec');
  assert.ok(cmds.some((c) => c.includes('checkout -q -B villaforge/integration-42')), 'Feature-Branch wird angelegt');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/niknight1403/Agentforge2/pulls');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.base, 'main');
  assert.equal(payload.head, 'villaforge/integration-42-integration-dateimanager');
  assert.equal(payload.title, 'Integration: Dateimanager');
});

test('Bereits vorhandener PR ist ein eigener Zustand, kein stiller Erfolg', async () => {
  const { exec } = recorder();
  const { fetchFn } = prFetch({}, 422);
  const result = await publishIntegration({
    villaId: 6, root: checkoutDir('dupe'), repo: 'o/r', baseBranch: 'main',
    featureBranch: 'villaforge/integration-6', title: 'T', message: 'M',
    token: 'ghp_testtoken123456', exec, fetchFn
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'pull_request');
  assert.match(result.error, /bereits ein Pull Request/);
});

/* ---------------- Verdrahtung in publishToGitHub ---------------- */

test('gebundene Villa veroeffentlicht per PR statt ein neues Repository anzulegen', async () => {
  const dir = checkoutDir('bound');
  const villaId = addVilla('Gebundene Villa', dir);
  bindVillaRepo(villaId, { repo: 'niknight1403/Agentforge2', branch: 'main' });
  db.prepare("INSERT OR REPLACE INTO secrets (name, value, updated_at) VALUES ('GITHUB_TOKEN','ghp_testtoken123456',0)").run();

  const cmds = [];
  const exec = (cmd) => { cmds.push(cmd); return null; };
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/pulls')) {
      return new Response(JSON.stringify({ number: 77, html_url: 'https://github.com/niknight1403/Agentforge2/pull/77' }), { status: 201 });
    }
    throw new Error('unerwartet: ' + url);
  };

  const result = await publishToGitHub(villaId, 1, { title: 'Dateimanager ergänzen' }, { exec, fetchFn });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.url, 'https://github.com/niknight1403/Agentforge2/pull/77');
  assert.ok(!calls.some((c) => c.url.endsWith('/user') || c.url.endsWith('/user/repos')), 'kein neues Repository fuer eine gebundene Villa');
  const push = cmds.find((c) => c.includes(' push '));
  assert.ok(push.includes(`villaforge/integration-${villaId}`));
  assert.ok(push.includes('refs/heads/'), 'Push adressiert einen expliziten Branch');
  assert.ok(!/--force/.test(push));
});

test('ungebundene Villa behaelt den Produkt-Repo-Weg', async () => {
  const dir = checkoutDir('free');
  const villaId = addVilla('Freie Villa', dir);
  const cmds = [];
  const exec = (cmd) => { cmds.push(cmd); return null; };
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/user')) return new Response(JSON.stringify({ login: 'niknight1403' }), { status: 200 });
    if (String(url).endsWith('/user/repos')) return new Response(JSON.stringify({ full_name: 'x' }), { status: 201 });
    throw new Error('unerwartet: ' + url);
  };
  const result = await publishToGitHub(villaId, 1, { title: 'Produkt' }, { exec, fetchFn });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(calls.some((c) => c.url.endsWith('/user/repos')), 'eigenes Repository wird angelegt');
  assert.ok(existsSync(dir));
  const push = cmds.find((c) => c.includes(' push '));
  assert.ok(push.includes('villaforge-freie-villa'), 'Pusht ins eigene Produkt-Repo');
});
