import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VERSION } from '../version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('Hub, npm package, and Android app use the same release version', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const android = readFileSync(resolve(root, 'app/build.gradle.kts'), 'utf8');
  assert.equal(VERSION, pkg.version);
  assert.match(android, new RegExp(`versionName = "${VERSION.replaceAll('.', '\\.') }"`));
  const code = Number(android.match(/versionCode\s*=\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(code) && code > 41, 'Android versionCode must advance beyond the previous release');
  assert.match(VERSION, /^\\d+\\.\\d+\\.\\d+$/, 'release version must use semantic versioning');
  const notes = readFileSync(resolve(root, `docs/releases/v${VERSION}.md`), 'utf8');
  assert.ok(notes.includes(`VillaForge ${VERSION}`), 'release notes must exist and match the current version');
});
