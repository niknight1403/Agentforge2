/**
 * Worker-Dienst der Full-Stack-Engine.
 *
 * Ein Worker liest Bauauftraege aus dem Stream `agentforge:events:stream`,
 * arbeitet sie ab und bestaetigt (XACK) erst nach Abschluss. Ein Absturz
 * hinterlaesst damit ein haengendes Paket, das ein anderer Worker per
 * XAUTOCLAIM uebernimmt - kein Auftrag geht still verloren.
 *
 * Auftragsformat (Feld `json` im Stream-Eintrag):
 *   { "type": "fullstack.build.requested",
 *     "request": "Baue ein Rechnungs-Tool mit Kunden und PDF-Export",
 *     "outDir": "/pfad/unter/arbeitsbasis", "projectName": "Rechnungstool",
 *     "taskId": 42, "agentId": 7 }
 *
 * `request` ist Daten, keine Anweisung an diesen Prozess: der Worker baut
 * ausschliesslich Dateien aus Vorlagen, startet keine fremden Befehle und
 * schreibt nie ausserhalb der Arbeitsbasis.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import {
  redisTryAck, redisTryClaimStale, redisTryCreateConsumerGroup, redisTryReadConsumerGroup,
} from '../redis.mjs';
import { FULLSTACK_EVENT_STREAM } from './events.mjs';
import { runFullstackBuild } from './engine.mjs';
import { slugify } from './manifest.mjs';

export const FULLSTACK_WORKER_GROUP = process.env.VF_FULLSTACK_WORKER_GROUP || 'agentforge-fullstack-workers';
export const FULLSTACK_COMMAND_TYPE = 'fullstack.build.requested';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DATA = resolve(process.env.VF_FULLSTACK_DATA_DIR || join(process.cwd(), 'server/data/fullstack'));
const HEALTH = join(DATA, 'worker-health.json');
const MAX_REQUEST = 20_000;

/** Arbeitsbasis: standardmaessig ein eigener Unterordner, nie das Repo selbst. */
export function workerBaseDir() {
  return resolve(process.env.VF_FULLSTACK_WORKSPACE || join(DATA, 'projects'));
}

function safeTarget(baseDir, requested, slug) {
  const base = resolve(baseDir);
  const target = requested ? resolve(base, String(requested)) : join(base, slug);
  if (!target.startsWith(base + sep)) throw Object.assign(new Error('Ziel liegt ausserhalb der Arbeitsbasis.'), { code: 'FULLSTACK_TARGET_OUTSIDE_BASE' });
  return target;
}

/** Liest einen Stream-Eintrag als Bauauftrag. Unbekannte Typen werden ignoriert. */
export function parseCommand(entry) {
  const event = entry?.event || null;
  if (!event || event.type !== FULLSTACK_COMMAND_TYPE) return { ok: false, reason: 'not_a_command' };
  const request = String(event.request || '').trim();
  if (request.length < 10) return { ok: false, reason: 'request_too_short' };
  if (request.length > MAX_REQUEST) return { ok: false, reason: 'request_too_long' };
  const outDir = event.outDir ? String(event.outDir) : '';
  if (outDir && (isAbsolute(outDir) || outDir.split(/[\\/]/).includes('..'))) return { ok: false, reason: 'out_dir_unsafe' };
  const taskId = Number(event.taskId);
  const agentId = Number(event.agentId);
  return {
    ok: true,
    command: {
      type: FULLSTACK_COMMAND_TYPE,
      request,
      outDir,
      projectName: event.projectName ? String(event.projectName).slice(0, 80) : undefined,
      taskId: Number.isSafeInteger(taskId) && taskId > 0 ? taskId : undefined,
      agentId: Number.isSafeInteger(agentId) && agentId > 0 ? agentId : undefined,
      maxRepairs: Number.isSafeInteger(event.maxRepairs) ? Math.max(0, Math.min(5, event.maxRepairs)) : undefined,
    },
  };
}

export function writeWorkerHealth(state) {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(HEALTH, `${JSON.stringify({ updatedAt: new Date().toISOString(), ...state }, null, 2)}\n`, 'utf8');
    return HEALTH;
  } catch {
    return null;
  }
}

/** Arbeitet genau einen Auftrag ab. Fehler werden zu STREAM_FAILED, nie zu einem Absturz. */
export async function handleCommand(command, { baseDir = workerBaseDir(), run = runFullstackBuild, sink } = {}) {
  const started = Date.now();
  const slug = slugify(command.projectName || command.request.slice(0, 40));
  let outDir = '';
  try {
    outDir = safeTarget(baseDir, command.outDir, slug);
    const result = await run({
      request: command.request,
      outDir,
      projectName: command.projectName,
      taskId: command.taskId,
      agentId: command.agentId,
      maxRepairs: command.maxRepairs,
      sink,
    });
    return { ok: result.ok === true, outDir: result.root, result, durationMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      outDir,
      durationMs: Date.now() - started,
      failure: { code: String(error?.code || 'WORKER_FAILED'), detail: String(error?.message || 'Unbekannter Fehler').slice(0, 300) },
    };
  }
}

/**
 * Eine Runde: haengende Pakete zurueckholen, neue lesen, abarbeiten, bestaetigen.
 * `once: true` beendet nach einer Runde (Tests, Cron-Betrieb).
 */
export async function runWorkerOnce(options = {}) {
  const stream = options.stream || FULLSTACK_EVENT_STREAM;
  const group = options.group || FULLSTACK_WORKER_GROUP;
  const consumer = options.consumer || `${hostname().replace(/[^a-zA-Z0-9:_-]/g, '-')}:${process.pid}`;
  const created = await redisTryCreateConsumerGroup(stream, group);
  if (created === null) return { ok: false, reason: 'redis_unavailable', handled: 0 };

  const rows = (await redisTryClaimStale(stream, group, consumer, { minIdleMs: options.claimAfterMs || 60_000 }))
    || (await redisTryReadConsumerGroup(stream, group, consumer, { count: options.count || 5 }))
    || [];

  let handled = 0;
  let failed = 0;
  let skipped = 0;
  const outcomes = [];
  for (const row of rows) {
    const parsed = parseCommand(row);
    if (!parsed.ok) {
      skipped += 1;
      await redisTryAck(stream, group, row.id);
      continue;
    }
    const outcome = await handleCommand(parsed.command, { sink: options.sink, baseDir: options.baseDir });
    if (outcome.ok) handled += 1;
    else failed += 1;
    outcomes.push({ id: row.id, ok: outcome.ok, outDir: outcome.outDir, durationMs: outcome.durationMs, failure: outcome.failure || null });
    // Nur bestaetigen, wenn der Auftrag wirklich durchgelaufen ist; ein Fehlschlag
    // wird ebenfalls bestaetigt, damit der Stream nicht endlos rotiert, bleibt
    // aber als STREAM_FAILED im Protokoll.
    await redisTryAck(stream, group, row.id);
  }
  writeWorkerHealth({ status: 'idle', handled, failed, skipped, lastRun: new Date().toISOString(), outcomes: outcomes.slice(0, 5) });
  return { ok: true, handled, failed, skipped, outcomes };
}

/** Dauerbetrieb bis zum Signal. Polling ist nicht blockierend. */
export async function startFullstackWorker(options = {}) {
  const pollMs = Math.max(250, Number(options.pollMs) || 1500);
  const stream = options.stream || FULLSTACK_EVENT_STREAM;
  const group = options.group || FULLSTACK_WORKER_GROUP;
  const consumer = options.consumer || `${hostname().replace(/[^a-zA-Z0-9:_-]/g, '-')}:${process.pid}`;
  const created = await redisTryCreateConsumerGroup(stream, group);
  if (created === null) return { ok: false, reason: 'redis_unavailable', stop: () => {} };

  let stopped = false;
  let active = false;
  const stop = () => { stopped = true; };
  const signal = options.signal;
  writeWorkerHealth({ status: 'starting', stream, group, consumer, pid: process.pid, health: HEALTH });

  const loop = (async () => {
    while (!stopped && !signal?.aborted) {
      if (active) { await sleep(pollMs); continue; }
      active = true;
      try {
        await runWorkerOnce({ stream, group, consumer, sink: options.sink, baseDir: options.baseDir, count: options.count });
        writeWorkerHealth({ status: 'polling', stream, group, consumer, pid: process.pid, lastPoll: new Date().toISOString() });
      } catch (error) {
        writeWorkerHealth({ status: 'degraded', stream, group, consumer, pid: process.pid, lastError: String(error?.message || 'worker_error').slice(0, 200) });
        options.onError?.(error);
      } finally {
        active = false;
      }
      if (!stopped && !signal?.aborted) await sleep(pollMs);
    }
    writeWorkerHealth({ status: 'stopped', stream, group, consumer, pid: process.pid });
  })();

  return { ok: true, stop, done: loop, stream, group, consumer, health: existsSync(HEALTH) };
}
