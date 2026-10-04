import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSummary, searchProject, readProjectFile, runCommand, safePath, projectTree, ALLOWED } from '../fs-tools.mjs';

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

test('safePath: Symlink ausserhalb des Projekts wird abgewiesen', () => {
  // Angreifer-Szenario: ein Link im Projekt zeigt auf eine echte Datei
  // ausserhalb der Wurzel — und einmal auf ein nicht vorhandenes Ziel.
  const aussen = join(tmpdir(), 'vf-aussen.txt');
  writeFileSync(aussen, 'geheim');
  const link = join(ROOT, 'escape.js');
  try { rmSync(link, { force: true }); } catch {}
  try { symlinkSync(aussen, link); } catch { return; } // Sandbox ohne Symlink-Rechte: Test entfaellt
  assert.equal(safePath(ROOT, 'escape.js'), null, 'Symlink-Ausbruch wurde erlaubt');
  assert.ok(readProjectFile(ROOT, 'escape.js').ok === false, 'Lesen ueber Symlink erlaubt');
  rmSync(link, { force: true });

  // Variante 2: haengender Link (Ziel existiert nicht).
  try { symlinkSync(join(tmpdir(), 'vf-gibt-es-nicht.txt'), link); } catch { return; }
  assert.equal(safePath(ROOT, 'escape.js'), null, 'Haengender Link wurde erlaubt');
  rmSync(link, { force: true });
});

test('safePath: Link innerhalb des Projekts bleibt nutzbar', () => {
  try { symlinkSync('src/app.js', join(ROOT, 'alias.js')); } catch { return; }
  assert.ok(safePath(ROOT, 'alias.js'), 'legitimer interner Link wurde abgelehnt');
  const r = readProjectFile(ROOT, 'alias.js');
  assert.ok(r.ok && r.content.includes('hallo'), 'Lesen ueber internen Link scheiterte');
  rmSync(join(ROOT, 'alias.js'), { force: true });
});

test('safePath: verzeichnislolge Wurzel wird abgelehnt', () => {
  assert.equal(safePath(join(ROOT, 'gibt-es-nicht'), 'datei.js'), null);
});


test('projectTree: ignoriert Abhaengigkeits- und Punktordner, respektiert Limit', () => {
  mkdirSync(join(ROOT, 'node_modules'), { recursive: true });
  mkdirSync(join(ROOT, '.versteckt'), { recursive: true });
  writeFileSync(join(ROOT, 'node_modules', 'boese.js'), 'x');
  writeFileSync(join(ROOT, '.versteckt', 'geheim.js'), 'x');
  const tree = projectTree(ROOT);
  assert.ok(!tree.some((f) => f.path.startsWith('node_modules')), 'node_modules wurde gelistet');
  assert.ok(!tree.some((f) => f.path.includes('.versteckt')), 'Punktordner wurde gelistet');

  const limited = projectTree(ROOT, 2);
  assert.equal(limited.length, 2, 'Limit wurde ignoriert');
});

test('readProjectFile: lehnt Binaer- und Nicht-Text-Erweiterungen ab', () => {
  writeFileSync(join(ROOT, 'bild.png'), '\x89PNG\r\n');
  const r = readProjectFile(ROOT, 'bild.png');
  assert.ok(!r.ok, 'Binaerdatei wurde gelesen');
  assert.equal(readProjectFile(ROOT, 'src').ok, false, 'Verzeichnis wurde gelesen');
  assert.equal(readProjectFile(ROOT, 'gibt-es-nicht.js').ok, false);
});

test('searchProject: Limit begrenzt Treffer', () => {
  for (let i = 0; i < 8; i++) writeFileSync(join(ROOT, `limit-${i}.txt`), 'NEEDLE\n');
  const hits = searchProject(ROOT, 'NEEDLE', 3);
  assert.equal(hits.length, 3, 'Limit nicht durchgesetzt');
});

test('runCommand: Timeout bricht haengende Skripte ab', async () => {
  writeFileSync(join(ROOT, 'haeng.cjs'), 'setTimeout(() => {}, 60000);\n');
  const r = await runCommand(ROOT, 'node', ['haeng.cjs'], 800);
  assert.ok(!r.ok, 'Timeout wurde nicht durchgesetzt');
  assert.ok(r.error.includes('Zeitlimit'), `Timeout nicht klar gemeldet: ${JSON.stringify(r)}`);
});
