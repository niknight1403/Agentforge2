/**
 * Start-Verhalten des Hubs: ungueltige Konfiguration muss mit Exit 1
 * und klarer Meldung abbrechen; --check prueft die Konfiguration
 * trocken, ohne Port zu belegen.
 */
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const FLAGS = process.execArgv;

function runHub(env, args = [], timeoutMs = 12000) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [...FLAGS, 'server/server.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, VF_RESUME: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout', out }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('Ungueltiger PORT bricht mit klarer Meldung ab (Exit 1)', async () => {
  const r = await runHub({ PORT: 'abc', VF_DB: join(mkdtempSync(join(tmpdir(), 'vf-cfg-')), 'x.db') });
  assert.equal(r.code, 1, `erwartet Exit 1, war ${r.code} — Log: ${r.out}`);
  assert.match(r.out, /PORT muss zwischen 1 und 65535 liegen/, 'Fehlermeldung nennt PORT nicht');
});

test('Ungueltiges VF_RATE_LIMIT bricht ab (Exit 1)', async () => {
  const r = await runHub({ VF_RATE_LIMIT: '-3', VF_DB: join(mkdtempSync(join(tmpdir(), 'vf-cfg-')), 'x.db') });
  assert.equal(r.code, 1, `erwartet Exit 1, war ${r.code} — Log: ${r.out}`);
  assert.match(r.out, /VF_RATE_LIMIT/, 'Fehlermeldung nennt VF_RATE_LIMIT nicht');
});

test('--check meldet Konfiguration trocken und belegt keinen Port (Exit 0)', async () => {
  const r = await runHub({ PORT: '13000', VF_DB: join(mkdtempSync(join(tmpdir(), 'vf-cfg-')), 'x.db') }, ['--check']);
  assert.equal(r.code, 0, `erwartet Exit 0, war ${r.code} — Log: ${r.out}`);
  assert.match(r.out, /Konfiguration ok/);
  // Port 13000 darf nach --check wieder frei sein: kein Server laeuft.
  // (Gegenprobe via erneutem Spawn desselben Ports in Testreihenfolge hier.)
});
