#!/usr/bin/env node
/**
 * Release-Version an allen vier Stellen setzen.
 *
 * Der Automatik-Commit d5ed52a hat server/version.mjs und package.json auf
 * 1.60.7 gehoben, package-lock.json und app/build.gradle.kts aber auf 1.60.6
 * gelassen. Damit war release-version.test.mjs rot und der APK-Release
 * blockiert, weil Schritt 5 die Android-Version gegen den Tag prueft.
 *
 * Aufruf: node scripts/bump-version.mjs 1.61.0 [--notes "Kurzbeschreibung"]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = String(process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Aufruf: node scripts/bump-version.mjs <major.minor.patch> [--notes "Text"]');
  process.exit(2);
}
const notesIndex = process.argv.indexOf('--notes');
const notesText = notesIndex > 0 ? process.argv[notesIndex + 1] : '';

const aendern = [];

// 1) Hub-Version
const versionDatei = resolve(root, 'server/version.mjs');
const hub = readFileSync(versionDatei, 'utf8');
if (!/export const VERSION = '[^']+';/.test(hub)) throw new Error('server/version.mjs: VERSION nicht gefunden');
const hubNeu = hub.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${version}';`);
if (hubNeu !== hub) { writeFileSync(versionDatei, hubNeu); aendern.push('server/version.mjs'); }

// 2) npm-Paket
const pkgDatei = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgDatei, 'utf8'));
pkg.version = version;
writeFileSync(pkgDatei, `${JSON.stringify(pkg, null, 2)}\n`);
aendern.push('package.json');

// 3) Lock-Datei (npm ci vergleicht beide Felder)
const lockDatei = resolve(root, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockDatei, 'utf8'));
lock.version = version;
if (lock.packages && lock.packages['']) lock.packages[''].version = version;
writeFileSync(lockDatei, `${JSON.stringify(lock, null, 2)}\n`);
aendern.push('package-lock.json');

// 4) Android-App samt fortlaufendem versionCode
const gradleDatei = resolve(root, 'app/build.gradle.kts');
const gradle = readFileSync(gradleDatei, 'utf8');
const codeTreffer = gradle.match(/versionCode\s*=\s*(\d+)/);
if (!codeTreffer) throw new Error('app/build.gradle.kts: versionCode nicht gefunden');
// versionCode nur erhoehen, wenn sich die Version wirklich aendert; sonst
// verschiebt ein zweiter Lauf den Code ohne inhaltlichen Grund.
const schonGesetzt = new RegExp(`versionName\\s*=\\s*"${version.replaceAll('.', '\\.')}"`).test(gradle);
const neuerCode = schonGesetzt ? Number(codeTreffer[1]) : Number(codeTreffer[1]) + 1;
const gradleNeu = gradle
  .replace(/versionCode\s*=\s*\d+/, `versionCode = ${neuerCode}`)
  .replace(/versionName\s*=\s*"[^"]*"/, `versionName = "${version}"`);
if (gradleNeu !== gradle) { writeFileSync(gradleDatei, gradleNeu); aendern.push(`app/build.gradle.kts (versionCode ${neuerCode})`); }

// 5) Release-Notizen, damit das Gate eine Beschreibung findet
const notizDatei = resolve(root, `docs/releases/v${version}.md`);
if (!existsSync(notizDatei)) {
  writeFileSync(notizDatei, `## VillaForge ${version}\n\n${notesText || '### Aenderungen\n\n- '}\n`);
  aendern.push(`docs/releases/v${version}.md (neu)`);
} else if (notesText) {
  writeFileSync(notizDatei, `## VillaForge ${version}\n\n${notesText}\n`);
  aendern.push(`docs/releases/v${version}.md (aktualisiert)`);
}

console.log(`Version ${version} gesetzt:`);
for (const datei of aendern) console.log(`  - ${datei}`);
console.log('Bitte "npm test" laufen lassen: release-version.test.mjs prueft alle Quellen.');
