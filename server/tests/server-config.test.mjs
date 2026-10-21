import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { TMP } from './_env.mjs';

function check(port, suffix) {
  return spawnSync(process.execPath, ['server/server.mjs', '--check'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PORT: port, VF_DB: join(TMP, `${suffix}.db`), VF_WORKSPACE: join(TMP, `${suffix}-workspace`) }
  });
}

test('Server-Konfigurationscheck endet ohne Hub-Start und zeigt keine Geheimnisse', () => {
  const result = check('12001', 'config-valid');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ok": true/);
  assert.match(result.stdout, /"port": 12001/);
  assert.doesNotMatch(result.stdout, /Hub laeuft auf|API_KEY|sk-/);
});

test('Server weist einen ungueltigen Port mit klarer Meldung ab', () => {
  const result = check('abc', 'config-invalid');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ungueltige PORT-Konfiguration/);
});
