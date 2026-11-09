/**
 * Autonome Bau-Orchestrierung: Prompt -> Produkt (PEER-Loop).
 *
 *   Planner   deriveManifest()      erzeugt den Blueprint (project_manifest.json)
 *   Executor  emitProject()         schreibt Client, Server, Datenmodell, Auth
 *   Express   verifyProject()       Syntax, Vertraege, Inhalt, echte API-Tests
 *   Reviewer  repairProject()       schreibt betroffene Dateien aus der Vorlage neu
 *
 * Jeder Phasenwechsel wird als Ereignis auf den Stream gegeben und als
 * Checkpoint festgehalten. Der Loop ist begrenzt: max. `maxRepairs` Runden und
 * eine Gesamtfrist. Gibt es keinen Fortschritt, endet der Bau mit STREAM_FAILED
 * statt in einer Endlosschleife.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { db } from '../db.mjs';
import { saveCheckpoint } from '../checkpoints.mjs';
import { deriveManifest, summarizeManifest } from './manifest.mjs';
import { emitProject } from './emit.mjs';
import { verifyProject, summarizeVerification } from './verify.mjs';
import { repairProject } from './reviewer.mjs';
import { createFullstackEmitter } from './events.mjs';
import { deployManifest } from './templates-api.mjs';

const run = promisify(execFile);

const DEFAULT_MAX_REPAIRS = 2;
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

/** Legt bei Bedarf Agent und Aufgabe an, damit Checkpoints eine echte Bindung haben. */
export function ensureCheckpointIdentity({ taskId, agentId, projectName = 'Full-Stack-Generierung' } = {}) {
  const createdAt = Date.now();
  let identityAgent = Number(agentId);
  let identityTask = Number(taskId);
  if (!Number.isSafeInteger(identityAgent) || identityAgent < 1) {
    const agent = db.prepare('INSERT INTO agents (villa_id, name, role, system_prompt, status, is_root, parent_id, permissions, autonomy_level, created_at, last_active_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(0, 'Full-Stack-Engine', 'WORKER', 'Erzeugt und prueft vollstaendige Web-Anwendungen.', 'IDLE', 0, null, 127, 3, createdAt, createdAt);
    identityAgent = Number(agent.lastInsertRowid);
  }
  if (!Number.isSafeInteger(identityTask) || identityTask < 1) {
    const task = db.prepare('INSERT INTO tasks (villa_id, agent_id, title, description, status, priority, result, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(0, identityAgent, String(projectName).slice(0, 120), 'Autonomer Full-Stack-Bau', 'RUNNING', 5, '', createdAt, createdAt);
    identityTask = Number(task.lastInsertRowid);
  }
  return { taskId: identityTask, agentId: identityAgent };
}

function finishIdentity(taskId, result) {
  try {
    db.prepare('UPDATE tasks SET status=?, result=?, updated_at=? WHERE id=?').run(result.status, String(result.summary || '').slice(0, 2000), Date.now(), taskId);
  } catch { /* Der Bau bleibt gueltig, auch wenn der Status nicht geschrieben werden kann. */ }
}

/** Best-effort-Commit im Zielprojekt. Ohne git bleibt der Bau trotzdem nutzbar. */
export async function commitProject(root, { message = 'chore: generiertes Projekt' } = {}) {
  try {
    await run('git', ['init', '-q'], { cwd: root, timeout: 20000 });
    await run('git', ['add', '-A'], { cwd: root, timeout: 20000 });
    await run('git', ['-c', 'user.name=Agentforge2', '-c', 'user.email=agentforge@localhost', 'commit', '-qm', String(message)], { cwd: root, timeout: 20000 });
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 20000 });
    return { ok: true, commit: String(stdout).trim() };
  } catch (error) {
    return { ok: false, commit: null, reason: String(error?.code || error?.message || 'git_unavailable').slice(0, 120) };
  }
}

/**
 * Fuehrt einen kompletten Bau aus.
 *
 * @param {object} options
 * @param {string} options.request     Bauauftrag in natuerlicher Sprache (wird nicht gespeichert)
 * @param {string} options.outDir      Zielverzeichnis
 * @param {string} [options.projectName]
 * @param {number} [options.taskId]    Bindung an eine bestehende Aufgabe
 * @param {number} [options.agentId]   Bindung an einen bestehenden Agenten
 * @param {number} [options.maxRepairs]
 * @param {Function} [options.sink]    Ereignis-Senke (Tests/Weiterleitung)
 */
export async function runFullstackBuild(options = {}) {
  const started = Date.now();
  const deadline = started + (Number(options.deadlineMs) || DEFAULT_DEADLINE_MS);
  const maxRepairs = Number.isSafeInteger(options.maxRepairs) ? Math.max(0, Math.min(5, options.maxRepairs)) : DEFAULT_MAX_REPAIRS;
  const request = String(options.request || '');
  const outDir = String(options.outDir || '');
  if (!outDir) throw Object.assign(new Error('Es wird ein Zielverzeichnis benoetigt.'), { code: 'FULLSTACK_TARGET_MISSING' });

  const emitter = createFullstackEmitter({ sink: options.sink });
  const send = emitter.send;
  const checkpoints = [];
  const checkpointErrors = [];

  const planner = () => {
    const manifest = deriveManifest(request, { name: options.projectName });
    const summary = summarizeManifest(manifest);
    return { manifest, summary };
  };

  const { manifest, summary } = planner();
  const identity = ensureCheckpointIdentity({ taskId: options.taskId, agentId: options.agentId, projectName: summary.project });

  const checkpoint = (state, phase) => {
    try {
      const saved = saveCheckpoint({ taskId: identity.taskId, agentId: identity.agentId, state });
      checkpoints.push(saved.checkpointId);
      return saved;
    } catch (error) {
      checkpointErrors.push({ phase, code: String(error?.message || 'CHECKPOINT_FAILED').slice(0, 160) });
      return null;
    }
  };

  const result = {
    ok: false,
    project: summary.project,
    slug: summary.slug,
    blueprintDigest: summary.blueprintDigest,
    requestDigest: summary.requestDigest,
    root: outDir,
    taskId: identity.taskId,
    agentId: identity.agentId,
    files: [],
    verification: null,
    patches: [],
    escalated: [],
    checkpoints,
    checkpointErrors,
    commit: null,
    events: emitter.events,
    durationMs: 0,
  };

  await send('PROJECT_PLANNED', { phase: 'PLANNER', step: 1, blueprintDigest: summary.blueprintDigest, entities: summary.entities, routes: summary.routes });
  const plannedCheckpoint = checkpoint({ phase: 'PROJECT_PLANNED', blueprintDigest: summary.blueprintDigest, entities: summary.entities, routes: summary.routes }, 'PROJECT_PLANNED');
  if (plannedCheckpoint) await send('CHECKPOINT_SAVED', { phase: 'PROJECT_PLANNED', step: 1, checkpointId: plannedCheckpoint.checkpointId });

  let emission;
  try {
    emission = emitProject(manifest, outDir, { overwrite: options.overwrite === true });
  } catch (error) {
    const failed = await send('STREAM_FAILED', { phase: 'EXECUTOR', step: 2, code: String(error.code || 'EMIT_FAILED') });
    finishIdentity(identity.taskId, { status: 'FAILED', summary: `Emission fehlgeschlagen: ${error.message}` });
    return Object.assign(result, { ok: false, failure: { phase: 'EXECUTOR', code: String(error.code || 'EMIT_FAILED'), detail: String(error.message).slice(0, 300) }, events: emitter.events, durationMs: Date.now() - started, lastEvent: failed });
  }
  result.root = emission.root;
  result.files = emission.files;
  result.artifactDigest = emission.digest;

  await send('SCAFFOLD_GENERATED', { phase: 'EXECUTOR', step: 2, files: emission.files.length, blueprintDigest: summary.blueprintDigest });
  const scaffoldCheckpoint = checkpoint({ phase: 'SCAFFOLD_GENERATED', blueprintDigest: summary.blueprintDigest, files: emission.files.length, artifactDigest: emission.digest }, 'SCAFFOLD_GENERATED');
  if (scaffoldCheckpoint) await send('CHECKPOINT_SAVED', { phase: 'SCAFFOLD_GENERATED', step: 2, checkpointId: scaffoldCheckpoint.checkpointId });

  // Dokumentierter Eingriffspunkt fuer Werkzeuge und Tests: er erlaubt, den
  // erzeugten Baum vor der Pruefung zu inspizieren oder absichtlich zu
  // beschaedigen, damit der Selbstkorrektur-Pfad belegt werden kann.
  if (typeof options.afterScaffold === 'function') {
    await options.afterScaffold({ root: emission.root, manifest, files: emission.files });
  }

  let verification = await verifyProject(emission.root, manifest, options.verify);
  result.verification = summarizeVerification(verification);
  let attempt = 0;
  let lastFailureCount = verification.failures.length;

  while (!verification.ok && attempt < maxRepairs) {
    if (Date.now() > deadline) break;
    attempt += 1;
    await send('CONTAINER_TEST_FAILED', {
      phase: 'EXPRESS', step: 2 + attempt, pass: attempt - 1, failures: verification.failures.length,
      testsPassed: verification.tests.pass, testsFailed: verification.tests.fail,
      durationMs: verification.durationMs, code: verification.failures[0]?.code || 'VERIFY_FAILED',
    });
    const review = repairProject(emission.root, manifest, verification, options.repair);
    result.patches.push(...review.patches);
    result.escalated.push(...review.escalated);
    const repairCheckpoint = checkpoint({ phase: 'REPAIR_APPLIED', blueprintDigest: summary.blueprintDigest, repairs: review.patches.length, failures: verification.failures.length, attempt }, 'REPAIR_APPLIED');
    if (repairCheckpoint) await send('CHECKPOINT_SAVED', { phase: 'REPAIR_APPLIED', step: 2 + attempt, checkpointId: repairCheckpoint.checkpointId, repairs: review.patches.length });

    verification = await verifyProject(emission.root, manifest, options.verify);
    result.verification = summarizeVerification(verification);
    if (!review.patches.length) break;
    if (verification.failures.length >= lastFailureCount && review.repaired === 0) break;
    lastFailureCount = verification.failures.length;
  }

  if (!verification.ok) {
    const code = verification.failures[0]?.code || 'VERIFY_FAILED';
    await send('STREAM_FAILED', { phase: 'REVIEWER', step: 9, failures: verification.failures.length, code, durationMs: Date.now() - started });
    finishIdentity(identity.taskId, { status: 'FAILED', summary: `Nicht verifiziert: ${code}` });
    result.durationMs = Date.now() - started;
    result.failure = { phase: 'REVIEWER', code, failures: verification.failures.slice(0, 10) };
    return result;
  }

  await send('CONTAINER_TEST_PASSED', {
    phase: 'EXPRESS', step: 8, pass: attempt + 1, failures: 0,
    testsPassed: verification.tests.pass, testsFailed: verification.tests.fail, durationMs: verification.durationMs, ok: true,
  });
  const passedCheckpoint = checkpoint({ phase: 'CONTAINER_TEST_PASSED', blueprintDigest: summary.blueprintDigest, testsPassed: verification.tests.pass, files: emission.files.length, repairs: result.patches.length }, 'CONTAINER_TEST_PASSED');
  if (passedCheckpoint) await send('CHECKPOINT_SAVED', { phase: 'CONTAINER_TEST_PASSED', step: 8, checkpointId: passedCheckpoint.checkpointId });

  const manifestPath = join(emission.root, 'deploy-manifest.json');
  writeFileSync(manifestPath, deployManifest(manifest, {
    files: emission.files,
    commit: null,
    checks: { blueprint: summary.blueprintDigest, artifact: emission.digest, verification: result.verification },
  }), 'utf8');

  const committed = options.commit === false ? { ok: false, commit: null, reason: 'disabled' } : await commitProject(emission.root, { message: `feat: ${summary.project} generiert und verifiziert` });
  if (committed.ok) {
    result.commit = committed.commit;
    const deploy = deployManifest(manifest, {
      files: emission.files,
      commit: committed.commit,
      checks: { blueprint: summary.blueprintDigest, artifact: emission.digest, verification: result.verification },
    });
    writeFileSync(manifestPath, deploy, 'utf8');
    try {
      await run('git', ['add', 'deploy-manifest.json'], { cwd: emission.root, timeout: 20000 });
      await run('git', ['-c', 'user.name=Agentforge2', '-c', 'user.email=agentforge@localhost', 'commit', '-qm', 'chore: deploy-manifest mit Commit-Bindung'], { cwd: emission.root, timeout: 20000 });
    } catch { /* Manifest bleibt im Baum, auch ohne zweiten Commit */ }
  } else if (!result.commit) {
    result.commitNote = committed.reason;
  }

  result.ok = true;
  result.durationMs = Date.now() - started;
  finishIdentity(identity.taskId, { status: 'COMPLETED', summary: `Verifiziert: ${emission.files.length} Dateien, ${verification.tests.pass} Tests` });
  await send('STREAM_COMPLETE', {
    phase: 'DONE', step: 10, files: emission.files.length, testsPassed: verification.tests.pass,
    repairs: result.patches.length, durationMs: result.durationMs, commit: result.commit || undefined,
    blueprintDigest: summary.blueprintDigest, ok: true,
  });
  const completeCheckpoint = checkpoint({ phase: 'STREAM_COMPLETE', blueprintDigest: summary.blueprintDigest, commit: result.commit || 'none', files: emission.files.length, repairs: result.patches.length }, 'STREAM_COMPLETE');
  if (completeCheckpoint) await send('CHECKPOINT_SAVED', { phase: 'STREAM_COMPLETE', step: 10, checkpointId: completeCheckpoint.checkpointId });
  return result;
}

/** Nur der Plan, ohne Dateien: Vorschau fuer Oberflaeche und CLI. */
export function planOnly(request, options = {}) {
  const manifest = deriveManifest(request, { name: options.projectName });
  return { manifest, summary: summarizeManifest(manifest) };
}

export { mkdirSync };
