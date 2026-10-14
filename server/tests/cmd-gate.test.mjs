/**
 * Tests fuer die globale Begrenzung der Projektbefehle (fs-tools.mjs).
 * Mehrere Villen duerfen gleichzeitig verifizieren, es laeuft aber hoechstens
 * VF_CMD_MAX_CONCURRENT Befehl zur selben Zeit; alle werden bedient.
 */
import './_env.mjs';
process.env.VF_CMD_MAX_CONCURRENT = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, cmdGateStatus } from '../fs-tools.mjs';

test('Projektbefehle laufen nacheinander, nicht gleichzeitig', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-cmd-'));
  // Jedes Skript merkt sich Start/Ende; ueberlappen sie, ist die Grenze kaputt.
  writeFileSync(join(dir, 'job.mjs'),
    "import { appendFileSync } from 'node:fs';\n" +
    `const f = ${JSON.stringify(join(dir, 'log.txt'))};\n` +
    "appendFileSync(f, 'S\\n'); await new Promise(r => setTimeout(r, 150)); appendFileSync(f, 'E\\n');\n");

  const results = await Promise.all(
    Array.from({ length: 4 }, () => runCommand(dir, 'node', ['job.mjs'], 20000))
  );
  assert.ok(results.every((r) => r.ok), 'alle 4 Befehle erfolgreich: ' + JSON.stringify(results.map((r) => r.error)));

  const { readFileSync } = await import('node:fs');
  const seq = readFileSync(join(dir, 'log.txt'), 'utf8').trim().split('\n').join('');
  assert.equal(seq, 'SESESESE', `Befehle haben sich ueberlappt: ${seq}`);

  const g = cmdGateStatus();
  assert.equal(g.max, 1);
  assert.equal(g.active, 0);
  assert.equal(g.queued, 0);
});
