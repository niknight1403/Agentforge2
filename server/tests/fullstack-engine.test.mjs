import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFullstackBuild, planOnly } from '../fullstack/engine.mjs';
import { buildFullstackEvent, FULLSTACK_EVENT_TYPES } from '../fullstack/events.mjs';
import { recoverCheckpoint } from '../checkpoints.mjs';

const PROMPT = 'Baue ein Projektmanagement-Tool mit Projekten, Aufgaben und Kunden.';
const EVENT_ORDER = ['PROJECT_PLANNED', 'SCAFFOLD_GENERATED', 'CONTAINER_TEST_PASSED', 'STREAM_COMPLETE'];

function workspace() {
  return mkdtempSync(join(tmpdir(), 'fs-engine-'));
}

test('kompletter Bau: Plan, Emission, Pruefung, Commit und Metadaten-Events', async () => {
  const dir = workspace();
  const events = [];
  const result = await runFullstackBuild({
    request: PROMPT,
    outDir: join(dir, 'app'),
    sink: event => { events.push(event); },
  });

  assert.equal(result.ok, true, 'Bau fehlgeschlagen: ' + JSON.stringify(result.failure || {}).slice(0, 400));
  assert.ok(result.files.length >= 40, 'zu wenige Dateien: ' + result.files.length);
  assert.equal(result.verification.testsFailed, 0);
  assert.ok(result.verification.testsPassed >= 8, 'API-Tests fehlen: ' + result.verification.testsPassed);
  assert.deepEqual(result.checkpointErrors, [], 'Checkpoints duerfen nicht scheitern');
  assert.ok(result.checkpoints.length >= 4, 'zu wenige Checkpoints: ' + result.checkpoints.length);

  const types = events.map(event => event.type);
  for (const required of EVENT_ORDER) assert.ok(types.includes(required), required + ' fehlt im Stream');
  assert.ok(types.indexOf('PROJECT_PLANNED') < types.indexOf('SCAFFOLD_GENERATED'));
  assert.ok(types.indexOf('SCAFFOLD_GENERATED') < types.indexOf('CONTAINER_TEST_PASSED'));
  assert.ok(types.indexOf('CONTAINER_TEST_PASSED') < types.indexOf('STREAM_COMPLETE'));
  assert.equal(types.at(-1), 'CHECKPOINT_SAVED', 'Der Bau endet mit gesichertem Checkpoint');

  const complete = events.find(event => event.type === 'STREAM_COMPLETE');
  assert.equal(complete.ok, true);
  assert.equal(complete.files, result.files.length);
  assert.equal(JSON.stringify(events).includes(PROMPT), false, 'Auftragstext darf nicht im Stream landen');

  if (result.commit) {
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    const deploy = JSON.parse(readFileSync(join(result.root, 'deploy-manifest.json'), 'utf8'));
    assert.equal(deploy.commit, result.commit);
    assert.equal(deploy.blueprintDigest, result.blueprintDigest);
    assert.equal(deploy.files, result.files.length);
  } else {
    assert.ok(result.commitNote, 'Ohne git muss der Grund dokumentiert sein');
  }

  const recovery = recoverCheckpoint(result.taskId, result.agentId);
  assert.ok(recovery, 'Checkpoint-Kette ist nicht wiederherstellbar');
  assert.equal(recovery.sequence, result.checkpoints.length, 'Jede Phase hat einen Checkpoint');
  assert.equal(recovery.state.phase, 'STREAM_COMPLETE');
  assert.equal(recovery.state.blueprintDigest, result.blueprintDigest);
});

test('Selbstkorrektur: beschaedigter Baum wird repariert und erneut geprueft', async () => {
  const dir = workspace();
  const events = [];
  const result = await runFullstackBuild({
    request: PROMPT,
    outDir: join(dir, 'app'),
    sink: event => { events.push(event); },
    afterScaffold: ({ root }) => {
      rmSync(join(root, 'server/lib/jwt.mjs'));
      writeFileSync(join(root, 'server/routes/task.routes.mjs'), 'export function kaputt( {\n', 'utf8');
    },
  });

  assert.equal(result.ok, true, 'Reparatur griff nicht: ' + JSON.stringify(result.failure || {}).slice(0, 400));
  const types = events.map(event => event.type);
  assert.ok(types.includes('CONTAINER_TEST_FAILED'), 'Fehlschlag wurde nicht gemeldet');
  assert.ok(types.indexOf('CONTAINER_TEST_FAILED') < types.indexOf('CONTAINER_TEST_PASSED'), 'Reihenfolge falsch');
  assert.ok(result.patches.length >= 2, 'erwartete Reparaturen: ' + result.patches.length);
  const repairedFiles = result.patches.map(patch => patch.file);
  assert.ok(repairedFiles.includes('server/lib/jwt.mjs'), 'fehlende Datei nicht neu geschrieben: ' + repairedFiles.join(','));
  assert.ok(repairedFiles.includes('server/routes/task.routes.mjs'), 'kaputte Route nicht neu geschrieben');
  for (const patch of result.patches) {
    assert.ok(patch.diff.afterBytes > 0);
    assert.equal(patch.sha256.length, 64);
  }
  const failed = events.find(event => event.type === 'CONTAINER_TEST_FAILED');
  assert.equal(failed.ok, false);
  assert.ok(failed.failures > 0);
  assert.equal(result.verification.failures, 0);
});

test('ohne Reparaturbudget endet der Bau ehrlich mit STREAM_FAILED', async () => {
  const dir = workspace();
  const events = [];
  const result = await runFullstackBuild({
    request: PROMPT,
    outDir: join(dir, 'app'),
    maxRepairs: 0,
    sink: event => { events.push(event); },
    afterScaffold: ({ root }) => { rmSync(join(root, 'server/lib/jwt.mjs')); },
  });

  assert.equal(result.ok, false, 'Ein beschaedigter Bau darf nicht als Erfolg gelten');
  assert.equal(result.failure.code, 'MISSING_FILE');
  assert.equal(events.at(-1).type, 'STREAM_FAILED');
  assert.equal(events.at(-1).ok, false);
  assert.equal(events.some(event => event.type === 'STREAM_COMPLETE'), false);
  assert.ok(result.files.length >= 40, 'Die erzeugten Dateien bleiben als Zwischenstand erhalten');
});

test('Event-Vertrag transportiert nur Metadaten', () => {
  const event = buildFullstackEvent('PROJECT_PLANNED', {
    blueprintDigest: 'a'.repeat(64),
    entities: 3,
    routes: 17,
    request: 'GEHEIMER AUFTRAG',
    prompt: 'auch geheim',
    fileContent: 'const x = 1;',
    ok: true,
  });
  assert.equal(event.request, undefined);
  assert.equal(event.prompt, undefined);
  assert.equal(event.fileContent, undefined);
  assert.equal(event.entities, 3);
  assert.equal(event.blueprintDigest.length, 64);
  assert.equal(event.ok, true);
  assert.equal(buildFullstackEvent('CONTAINER_TEST_FAILED', {}).ok, false);
  assert.deepEqual(FULLSTACK_EVENT_TYPES.includes('STREAM_COMPLETE'), true);
  assert.throws(() => buildFullstackEvent('SOMETHING_ELSE', {}), error => error.code === 'FULLSTACK_EVENT_TYPE_INVALID');
});

test('Vorschau plant ohne Dateien und bleibt deterministisch', () => {
  const dir = workspace();
  const first = planOnly(PROMPT);
  const second = planOnly(PROMPT);
  assert.equal(first.summary.blueprintDigest, second.summary.blueprintDigest);
  assert.equal(existsSync(join(dir, 'app')), false, 'Vorschau darf nichts schreiben');
  assert.ok(first.summary.routes >= 5);
  assert.equal(first.manifest.entities.length >= 1, true);
});
