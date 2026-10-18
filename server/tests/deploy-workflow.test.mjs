import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../../.github/workflows/hub-deploy.yml', import.meta.url), 'utf8');
const testWorkflow = readFileSync(new URL('../../.github/workflows/hub-tests.yml', import.meta.url), 'utf8');

function remoteDeployScript() {
  const marker = "cat > /tmp/deploy.sh <<'DEP'\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, 'Remote-Deploy-Skript muss vorhanden sein');
  const end = workflow.indexOf('\n          DEP\n', start + marker.length);
  assert.notEqual(end, -1, 'Remote-Deploy-Skript muss geschlossen sein');
  return workflow.slice(start + marker.length, end)
    .split('\n')
    .map(line => line.replace(/^ {10}/, ''))
    .join('\n');
}

test('Hub-Deploy remote script has valid Bash syntax', () => {
  const result = spawnSync('bash', ['-n'], { input: remoteDeployScript(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'bash -n failed');
});

test('Hub-Deploy gates restart on passing tests and rolls back on health failure', () => {
  const script = remoteDeployScript();
  const tests = script.indexOf('node --test tests/*.test.mjs');
  const restart = script.indexOf('echo "== Neustart =="');
  assert.ok(tests >= 0 && restart > tests, 'Backend-Tests muessen vor dem Dienst-Neustart laufen');
  assert.match(script, /Backend-Tests fehlgeschlagen; Deploy wird abgebrochen/);
  assert.match(script, /ROLLBACK_REQUIRED=1/);
  assert.match(script, /git reset --hard "\$PREVIOUS_SHA"/);
  assert.doesNotMatch(script, /node --test tests\/\*\.test\.mjs[^\n]*\|\|\s*true/);
});

test('Hub-Deploy requires the Master API capability locally and through the proxy', () => {
  const script = remoteDeployScript();
  assert.equal((script.match(/master-control-v1/g) || []).length, 1);
  assert.match(workflow, /master-control-v1/);
  assert.match(workflow, /d\.get\("ok"\) is True/);
});

test('Hub-Tests runs when the Hub-Deploy workflow changes', () => {
  assert.match(testWorkflow, /- "\.github\/workflows\/hub-deploy\.yml"/);
});
