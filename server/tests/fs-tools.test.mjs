import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSummary, searchProject, readProjectFile, runCommand, safePath, ALLOWED } from '../fs-tools.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'vf-project-'));
mkdirSync(join(ROOT, 'src'), { recursive: true });
writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
writeFileSync(join(ROOT, 'src', 'app.js'), 'function hallo() { return 1; }\nmodule.exports = { hallo };\n');
writeFileSync(join(ROOT, 'src', 'util.js'), 'const MAGIC = 424242;\nmodule.exports = { MAGIC };\n');

test('projectSummary: zaehlt Dateien, Groesse und Sprachen', () => {
  const s = projectSummary(ROOT);
  assert.ok(s.exists);
  assert.equal(s.files >= 3, true);
  assert.ok(s.bytes > 0);
  assert.ok(s.languages.some((l) => l.ext === '.js'));
  assert.ok(s.highlights.includes('package.json'));
});

test('projectSummary: nicht vorhandener Ordner', () => {
  const s = projectSummary(join(ROOT, 'gibt-es-nicht'));
  assert.equal(s.exists, false);
});

test('safePath: Ausbruch nach oben wird verhindert', () => {
  assert.equal(safePath(ROOT, '../aussen'), null);
  assert.equal(safePath(ROOT, '../../etc/passwd'), null);
  // Genestes .., das wieder innerhalb des Root aufloest, ist erlaubt.
  assert.equal(safePath(ROOT, 'src/../src/app.js'), join(ROOT, 'src/app.js'));
  assert.equal(safePath(ROOT, 'src/app.js'), join(ROOT, 'src/app.js'));
});

test('searchProject: findet Treffer mit Zeile, ignoriert Gross/Kleinschreibung nicht stoerend', () => {
  const hits = searchProject(ROOT, 'MAGIC', 10);
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].path.includes('util.js'));
  assert.ok(hits[0].text.includes('MAGIC'));
});

test('readProjectFile: liest, kuerzt und lehnt Ausbrueche ab', () => {
  const r = readProjectFile(ROOT, 'src/app.js');
  assert.ok(r.ok && r.content.includes('hallo'));

  const truncated = readProjectFile(ROOT, 'src/app.js', 5);
  assert.equal(truncated.truncated, true);

  const escape = readProjectFile(ROOT, '../../etc/passwd');
  assert.ok(!escape.ok, 'Pfad-Ausbruch wurde erlaubt');
});

test('runCommand: Whitelist haelt Shell, Netzwerk und Inline-Auswertung fern', async () => {
  const rm = await runCommand(ROOT, 'rm', ['-rf', '/']);
  assert.ok(!rm.ok && rm.error.includes('nicht erlaubt'));

  const install = await runCommand(ROOT, 'npm', ['install', 'left-pad']);
  assert.ok(!install.ok && install.error.includes('Unterbefehl nicht erlaubt'), 'npm install wurde erlaubt');

  const inline = await runCommand(ROOT, 'node', ['-e', 'process.exit(0)']);
  assert.ok(!inline.ok && inline.error.includes('Inline-Auswertung'));

  const pipe = await runCommand(ROOT, 'npm', ['run', 'a && echo']);
  assert.ok(!pipe.ok, 'Shell-Verkettung wurde erlaubt');

  const registry = await runCommand(ROOT, 'npm', ['run', 'x', '--registry', 'http://boese.de']);
  assert.ok(!registry.ok, '--registry wurde erlaubt');

  const missing = await runCommand(ROOT, 'node', ['gibt-echt-nicht.cjs']);
  assert.ok(!missing.ok, 'Skript ausserhalb des Projekts wurde erlaubt');
});

test('runCommand: erlaubter Testlauf funktioniert wirklich', async () => {
  // Ein minimales npm-Testskript im Temporaerprojekt.
  writeFileSync(join(ROOT, 'test-demo.cjs'), "require('assert').ok(true); console.log('demo-test-ok');\n");
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  pkg.scripts = { test: 'node test-demo.cjs' };
  writeFileSync(join(ROOT, 'package.json'), JSON.stringify(pkg));
  const r = await runCommand(ROOT, 'npm', ['test']);
  assert.ok(r.ok, `npm test scheiterte: ${r.output}`);
  assert.ok(r.output.includes('demo-test-ok'));
});

test('ALLOWED: Politik ist dokumentiert', () => {
  assert.ok(ALLOWED.some((a) => a.startsWith('npm')));
  assert.ok(!ALLOWED.some((a) => a.startsWith('rm')));
});
