import './_env.mjs';
import { TMP } from './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Daten- und Arbeitsordner muessen vor dem Import des Workers gesetzt sein:
// das Modul liest sie beim Laden (wie db.mjs).
process.env.VF_FULLSTACK_DATA_DIR = join(TMP, 'fullstack-data');
process.env.VF_FULLSTACK_WORKSPACE = join(TMP, 'fullstack-projects');
const worker = await import('../fullstack/worker.mjs');
const { parseCommand, handleCommand, runWorkerOnce, startFullstackWorker, writeWorkerHealth, workerBaseDir } = worker;

const COMMAND = {
  type: 'fullstack.build.requested',
  request: 'Baue ein Notiz-Tool mit Notizen und Kunden.',
  projectName: 'Notizwerk',
};

function entry(command) {
  return { id: '1-0', fields: { json: JSON.stringify(command) }, event: command };
}

test('Bauauftraege werden streng geparst', () => {
  const ok = parseCommand(entry(COMMAND));
  assert.equal(ok.ok, true);
  assert.equal(ok.command.request, COMMAND.request);
  assert.equal(ok.command.projectName, 'Notizwerk');

  assert.equal(parseCommand(entry({ type: 'anderes.event' })).reason, 'not_a_command');
  assert.equal(parseCommand(entry({ ...COMMAND, request: 'zu kurz' })).reason, 'request_too_short');
  assert.equal(parseCommand(entry({ ...COMMAND, request: 'x'.repeat(20_001) })).reason, 'request_too_long');
  assert.equal(parseCommand(entry({ ...COMMAND, outDir: '../ausbruch' })).reason, 'out_dir_unsafe');
  assert.equal(parseCommand(entry({ ...COMMAND, outDir: '/etc' })).reason, 'out_dir_unsafe');
  assert.equal(parseCommand({ id: '2-0', event: null }).reason, 'not_a_command');
});

test('Ziel bleibt immer in der Arbeitsbasis', async () => {
  const base = mkdtempSync(join(TMP, 'worker-base-'));
  let seen = null;
  const outcome = await handleCommand({ ...COMMAND, outDir: '' }, {
    baseDir: base,
    run: async options => { seen = options; return { ok: true, root: options.outDir }; },
  });
  assert.equal(outcome.ok, true);
  assert.ok(seen.outDir.startsWith(base), 'Ziel ausserhalb der Basis: ' + seen.outDir);
  assert.equal(seen.request, COMMAND.request);
  assert.equal(outcome.durationMs >= 0, true);

  const escape = await handleCommand({ ...COMMAND, outDir: '../ausbruch' }, { baseDir: base, run: async () => ({ ok: true }) });
  assert.equal(escape.ok, false);
  assert.equal(escape.failure.code, 'FULLSTACK_TARGET_OUTSIDE_BASE');

  const failed = await handleCommand(COMMAND, { baseDir: base, run: async () => { throw Object.assign(new Error('kaputt'), { code: 'BUILD_BROKEN' }); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.failure.code, 'BUILD_BROKEN');
});

test('Worker ohne Redis meldet ehrlich, dass er nicht arbeiten kann', async () => {
  const once = await runWorkerOnce();
  assert.equal(once.ok, false);
  assert.equal(once.reason, 'redis_unavailable');
  const loop = await startFullstackWorker({ pollMs: 250 });
  assert.equal(loop.ok, false);
  assert.equal(loop.reason, 'redis_unavailable');
  assert.equal(typeof loop.stop, 'function');
});

test('Worker baut einen Auftrag bis zum verifizierten Projekt', async () => {
  const base = workerBaseDir();
  const outcome = await handleCommand(COMMAND, { baseDir: base });
  assert.equal(outcome.ok, true, 'Worker-Bau fehlgeschlagen: ' + JSON.stringify(outcome.failure || {}));
  assert.ok(outcome.result.files.length >= 40);
  assert.equal(outcome.result.verification.testsFailed, 0);
  assert.ok(existsSync(join(outcome.outDir, 'server/app.mjs')));
  assert.ok(existsSync(join(outcome.outDir, 'project_manifest.json')));
  assert.ok(outcome.outDir.startsWith(base + '/'), 'Projekt liegt nicht in der Arbeitsbasis: ' + outcome.outDir);

  const blueprint = JSON.parse(readFileSync(join(outcome.outDir, 'project_manifest.json'), 'utf8'));
  assert.equal(blueprint.name, 'Notizwerk');
  assert.equal(JSON.stringify(blueprint).includes(COMMAND.request), false, 'Auftragstext im Projekt');
});

test('Health-Datei des Workers ist lesbar und beschreibt den Zustand', () => {
  const path = writeWorkerHealth({ status: 'idle', handled: 2, failed: 0 });
  assert.ok(path, 'Health-Datei konnte nicht geschrieben werden');
  const health = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(health.status, 'idle');
  assert.equal(health.handled, 2);
  assert.match(health.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});
