import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { hasAppEntryPoint, scaffoldAppShell } = await import('../builds.mjs');

function bruchstueckProjekt() {
  // Nachbau von Villa 10: Wissensdatenbank und ein Test, kein Einstiegspunkt.
  const dir = mkdtempSync(join(tmpdir(), 'villa-scaffold-'));
  writeFileSync(join(dir, 'docs_knowledge_base.md'), '# Wissen\n');
  mkdirSync(join(dir, 'project', 'tests'), { recursive: true });
  writeFileSync(join(dir, 'project', 'tests', 'test_optimizer.js'), 'export {};\n');
  return dir;
}

test('Villenprojekt ohne Einstiegspunkt wird als solches erkannt', () => {
  const dir = bruchstueckProjekt();
  assert.equal(hasAppEntryPoint(dir), false, 'Bruchstuecke sind kein App-Geruest');
});

test('Geruest ergaenzt AndroidManifest.xml und index.html mit dem Villeninhalt', () => {
  const dir = bruchstueckProjekt();
  const log = [];
  const villa = { id: 10, name: 'ableton Push Software' };
  assert.equal(scaffoldAppShell(villa, dir, (line) => log.push(line)), true);

  const manifest = join(dir, 'app-shell', 'app', 'src', 'main', 'AndroidManifest.xml');
  const page = join(dir, 'app-shell', 'app', 'src', 'main', 'assets', 'www', 'index.html');
  const gradle = join(dir, 'app-shell', 'app', 'build.gradle.kts');
  for (const file of [manifest, page, gradle]) assert.ok(existsSync(file), `${file} fehlt`);

  const html = readFileSync(page, 'utf8');
  assert.match(html, /ableton Push Software/, 'Startseite nennt die Villa');
  assert.match(html, /docs_knowledge_base\.md/, 'Startseite zeigt die echten Projektdateien');
  assert.doesNotMatch(html, /wird geladen/, 'kein Platzhaltertext der Vorlage');

  assert.equal(hasAppEntryPoint(dir), true, 'Gate-Pruefung findet den Einstiegspunkt');
  assert.ok(log.some((line) => /App-Geruest/.test(line)), 'Geruest wird protokolliert');
});

test('Bestehendes Geruest bleibt unveraendert', () => {
  const dir = bruchstueckProjekt();
  const villa = { id: 10, name: 'ableton Push Software' };
  scaffoldAppShell(villa, dir, () => {});
  const page = join(dir, 'app-shell', 'app', 'src', 'main', 'assets', 'www', 'index.html');
  writeFileSync(page, 'handgepflegt', 'utf8');
  assert.equal(scaffoldAppShell(villa, dir, () => {}), true);
  assert.equal(readFileSync(page, 'utf8'), 'handgepflegt', 'zweiter Lauf ueberschreibt nichts');
});

test('Projekt mit eigenem Einstiegspunkt bekommt kein Geruest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'villa-echt-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'echte-app', version: '1.0.0' }));
  assert.equal(hasAppEntryPoint(dir), true);
});
