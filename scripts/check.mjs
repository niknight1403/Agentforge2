#!/usr/bin/env node
/** Deterministic no-dependency quality gate for the complete Node/Web codebase. */
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['node_modules', 'dist', 'build', 'artifacts', '.git']);
const files = [];

function collect(dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) collect(path);
    } else if (/\.(?:mjs|js|cjs)$/.test(entry.name)) files.push(path);
  }
}

for (const dir of ['server', 'scripts']) collect(dir);
files.sort();
const syntaxFailures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) syntaxFailures.push({ file, result });
}
console.log(`[check] Syntaxpruefung: ${files.length} JavaScript-Dateien`);
for (const failure of syntaxFailures) {
  console.error(`\n[check] Syntaxfehler: ${relative(root, failure.file)}`);
  if (failure.result.stdout) process.stderr.write(failure.result.stdout);
  if (failure.result.stderr) process.stderr.write(failure.result.stderr);
}
if (syntaxFailures.length) process.exit(1);

function run(label, args) {
  console.log(`\n[check] ${label}`);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run('Secret-Scan', ['scripts/check-secrets.mjs']);
const tests = readdirSync(join(root, 'server/tests')).filter((file) => file.endsWith('.test.mjs')).sort().map((file) => join('server/tests', file));
run(`Unit- und Integrationstests (${tests.length} Testdateien)`, ['--test', ...tests]);
run('Web-Produktionsbuild', ['scripts/build-web.mjs']);
console.log('\n[check] Alle Qualitaetstore bestanden.');
