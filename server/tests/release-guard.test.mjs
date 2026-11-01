import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/build-apk.yml'), 'utf8');

// Die Release-Entscheidung aus dem Workflow schneiden, damit der Test genau
// den Code prueft, der im Runner laeuft - nicht eine Nachbildung davon.
const start = workflow.indexOf('TAG_SHA=$(gh api');
const ende = workflow.indexOf('NOTES="docs/releases/');
assert.ok(start > 0 && ende > start, 'Release-Block im Workflow gefunden');
const block = workflow.slice(start, ende);

const BUILD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function lauf(ghAntwort, zielSha = BUILD) {
  const script = [
    'gh() { printf %s "$GH_ANTWORT"; return "$GH_CODE"; }',
    'export GH_ANTWORT GH_CODE',
    'TAG=v1.60.6',
    `VF_BUILD_SHA=${zielSha}`,
    'GITHUB_REPOSITORY=beispiel/repo',
    block,
    'echo DURCHGELASSEN'
  ].join('\n');
  try {
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, GH_ANTWORT: ghAntwort, GH_CODE: ghAntwort ? '1' : '0' }
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, out: String(error.stdout || '') };
  }
}

test('fehlender Tag blockiert den Release nicht', () => {
  // gh gibt bei 422 den Fehler-Body auf stdout aus; das darf nicht als Tag-SHA gelten.
  const fehlerBody = '{"message":"No commit found for SHA: v1.60.6","documentation_url":"https://docs.github.com/rest/commits/commits#get-a-commit","status":"422"}';
  const ergebnis = lauf(fehlerBody);
  assert.equal(ergebnis.code, 0, 'Lauf darf nicht abbrechen');
  assert.match(ergebnis.out, /DURCHGELASSEN/);
});

test('leere Antwort und null blockieren den Release nicht', () => {
  for (const antwort of ['', 'null']) {
    const ergebnis = lauf(antwort);
    assert.equal(ergebnis.code, 0, `Antwort "${antwort}" darf nicht blockieren`);
  }
});

test('Tag eines anderen Commits wird weiterhin verweigert', () => {
  const ergebnis = lauf('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(ergebnis.code, 1, 'Schutz vor fremden Artefakten bleibt aktiv');
  assert.match(ergebnis.out, /gehoert zu/);
});

test('Tag auf demselben Commit laesst den Release zu', () => {
  const ergebnis = lauf(BUILD);
  assert.equal(ergebnis.code, 0);
  assert.match(ergebnis.out, /DURCHGELASSEN/);
});
