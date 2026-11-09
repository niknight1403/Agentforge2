import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveManifest } from '../fullstack/manifest.mjs';
import { buildFileMap, emitProject, plannedPaths } from '../fullstack/emit.mjs';
import { verifyProject, scanContent, checkJsx } from '../fullstack/verify.mjs';

const PROMPT = 'Baue ein Projektmanagement-Tool mit Projekten, Aufgaben, Kunden und einem Dashboard.';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'fs-emit-'));
}

function emitted(manifest = deriveManifest(PROMPT)) {
  const dir = workspace();
  const emission = emitProject(manifest, join(dir, 'app'));
  return { manifest, ...emission, dir };
}

test('Dateiplan ist deterministisch und deckt alle Schichten ab', () => {
  const manifest = deriveManifest(PROMPT);
  const first = plannedPaths(manifest);
  const second = plannedPaths(manifest);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length, 'keine doppelten Pfade');
  for (const expected of [
    'server/app.mjs', 'server/index.mjs', 'server/db.mjs', 'server/auth/middleware.mjs',
    'server/lib/jwt.mjs', 'server/lib/password.mjs', 'server/routes/auth.routes.mjs',
    'server/tests/api.test.mjs', 'prisma/schema.prisma', 'prisma/seed.mjs',
    'prisma/migrations/0001_init/migration.sql', 'client/src/App.jsx', 'package.json',
    'project_manifest.json', '.env.example', 'README.md',
  ]) {
    assert.ok(first.includes(expected), expected + ' fehlt im Dateiplan');
  }
  for (const entity of manifest.entities) {
    assert.ok(first.includes(`server/routes/${entity.key}.routes.mjs`), 'Routen fehlen fuer ' + entity.model);
    assert.ok(first.includes(`server/schemas/${entity.key}.schema.mjs`), 'Schema fehlt fuer ' + entity.model);
    assert.ok(first.includes(`client/src/pages/${entity.clientPage}.jsx`), 'Seite fehlt fuer ' + entity.model);
  }
});

test('Emission schreibt vollstaendigen Baum mit Manifest, Migration und Startskripten', () => {
  const { manifest, files, root } = emitted();
  assert.equal(files.length, buildFileMap(manifest).size);
  for (const file of files) {
    const absolute = join(root, file.path);
    assert.ok(existsSync(absolute), file.path + ' fehlt');
    assert.equal(readFileSync(absolute, 'utf8').length > 0, true, file.path + ' ist leer');
    assert.ok(file.sha256.length === 64);
  }
  const blueprint = JSON.parse(readFileSync(join(root, 'project_manifest.json'), 'utf8'));
  assert.equal(blueprint.digest, manifest.digest);
  assert.equal(blueprint.requestDigest, manifest.requestDigest);
  assert.equal(JSON.stringify(blueprint).includes(PROMPT), false, 'Auftragstext landet nicht im Projekt');

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node server/index.mjs');
  assert.equal(pkg.scripts.test, 'node --test server/tests/api.test.mjs');
  assert.equal(pkg.type, 'module');

  const prisma = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(join(root, 'prisma/migrations/0001_init/migration.sql'), 'utf8');
  for (const entity of manifest.entities) {
    assert.match(prisma, new RegExp(`model ${entity.model} \\{`));
    assert.ok(migration.includes(`CREATE TABLE "${entity.table}"`), 'Migration fehlt fuer ' + entity.table);
  }
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(manifest.name));
  for (const entity of manifest.entities) assert.ok(readme.includes(entity.route));
});

test('frisch erzeugtes Projekt besteht die komplette Pruefung inklusive API-Tests', async () => {
  const { manifest, root } = emitted();
  const result = await verifyProject(root, manifest);
  assert.equal(result.ok, true, 'Befunde: ' + JSON.stringify(result.failures.slice(0, 5)));
  assert.ok(result.files >= 40, 'zu wenige Dateien: ' + result.files);
  assert.equal(result.tests.ran, true, 'Laufzeitpruefung lief nicht');
  assert.ok(result.tests.pass >= 8, 'API-Tests fehlen: ' + result.tests.pass);
  assert.equal(result.tests.fail, 0);
});

test('beschaedigtes Projekt wird mit klaren Befunden abgelehnt, ohne Tests zu starten', async () => {
  const { manifest, root } = emitted();
  const routeFile = join(root, 'server/routes/project.routes.mjs');
  rmSync(routeFile);
  writeFileSync(join(root, 'server/lib/jwt.mjs'), 'export function verifyToken( {', 'utf8');

  const result = await verifyProject(root, manifest);
  assert.equal(result.ok, false);
  const codes = result.failures.map(failure => failure.code);
  assert.ok(codes.includes('MISSING_FILE'), 'fehlende Datei nicht erkannt: ' + codes.join(','));
  assert.ok(codes.includes('CONTENT_DRIFT'), 'Manipulation nicht erkannt: ' + codes.join(','));
  assert.ok(codes.includes('SYNTAX_ERROR'), 'Syntaxfehler nicht erkannt: ' + codes.join(','));
  assert.equal(result.tests.ran, false, 'Bei Strukturfehlern darf kein Lauf starten');
});

test('nicht leeres Ziel wird nicht ueberschrieben', () => {
  const manifest = deriveManifest(PROMPT);
  const dir = workspace();
  const target = join(dir, 'app');
  emitProject(manifest, target);
  assert.throws(() => emitProject(manifest, target), error => error.code === 'FULLSTACK_TARGET_NOT_EMPTY');
  const again = emitProject(manifest, target, { overwrite: true });
  assert.equal(again.files.length > 0, true);
});

test('Wurzelverzeichnis und fehlendes Ziel werden verweigert', () => {
  const manifest = deriveManifest(PROMPT);
  assert.throws(() => emitProject(manifest, '/'), error => error.code === 'FULLSTACK_TARGET_UNSAFE' || error.code === 'FULLSTACK_TARGET_NOT_EMPTY');
  assert.throws(() => emitProject(manifest, ''), error => error.code === 'FULLSTACK_TARGET_MISSING');
});

test('Inhaltsscanner findet Schluessel, Hostpfade und Platzhalter', () => {
  assert.equal(scanContent('a.mjs', 'const gsk_' + 'a'.repeat(24)).length, 1);
  assert.equal(scanContent('a.mjs', "const p = '/app/server/data/x';").length, 1);
  assert.equal(scanContent('a.mjs', '// TODO: spaeter').length, 1);
  const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  assert.equal(scanContent('a.mjs', `const key = '${pem}';`).length, 1);
  assert.deepEqual(scanContent('a.mjs', 'export const value = 42;'), []);
});

test('JSX-Pruefung erkennt unbalancierte und exportlose Komponenten', () => {
  assert.equal(checkJsx('export function A() { return (<div><span>x</span></div>); }'), null);
  assert.match(checkJsx('export function A() { return (<div><span>x</div>); }'), /nicht geschlossen/);
  assert.match(checkJsx('export function A() { return (<div>x</div>; }'), /Klammern/);
  assert.match(checkJsx('function A() { return (<div>x</div>); }'), /Kein Export/);
  assert.equal(checkJsx('function A() { return (<div>x</div>); }', { requireExport: false }), null);
});
