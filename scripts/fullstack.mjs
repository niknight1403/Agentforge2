#!/usr/bin/env node
/**
 * CLI der Full-Stack-Engine.
 *
 *   node scripts/fullstack.mjs "Baue ein Rechnungstool mit Kunden" --out ./out/rechnungstool
 *   node scripts/fullstack.mjs --plan "Baue ein Notiztool"
 *   node scripts/fullstack.mjs --from-file auftrag.txt --out ./out/app --name "MeinTool"
 *
 * Optionen: --out <dir> | --name <titel> | --plan | --json | --repairs <0-5> |
 *           --no-commit | --from-file <datei>
 * Exit-Code 0 nur bei verifiziertem Bau.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planOnly, runFullstackBuild } from '../server/fullstack/engine.mjs';

function parseArgs(argv) {
  const options = { request: '', out: '', name: undefined, plan: false, json: false, repairs: undefined, commit: true };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') options.plan = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-commit') options.commit = false;
    else if (arg === '--out') options.out = String(argv[++index] || '');
    else if (arg === '--name') options.name = String(argv[++index] || '');
    else if (arg === '--repairs') options.repairs = Number(argv[++index]);
    else if (arg === '--from-file') options.fromFile = String(argv[++index] || '');
    else if (arg.startsWith('--')) throw Object.assign(new Error('Unbekannte Option: ' + arg), { code: 'CLI_OPTION_UNKNOWN' });
    else rest.push(arg);
  }
  if (options.fromFile) options.request = readFileSync(resolve(options.fromFile), 'utf8').trim();
  else options.request = rest.join(' ').trim();
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.request) {
    console.error('Aufruf: node scripts/fullstack.mjs "<Bauauftrag>" --out <zielordner> [--name <titel>] [--plan|--json]');
    process.exit(2);
  }

  if (options.plan) {
    const plan = planOnly(options.request, { projectName: options.name });
    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const { summary, manifest } = plan;
      console.log(`Projekt:  ${summary.project} (${summary.slug})`);
      console.log(`Blueprint: ${summary.blueprintDigest.slice(0, 16)}  Rollen: ${summary.roles}`);
      console.log(`Domaenen: ${manifest.entities.map(entity => entity.model).join(', ')}`);
      console.log(`Routen:   ${summary.routes}  Seiten: ${summary.pages}`);
      for (const entity of manifest.entities) console.log(`  - ${entity.label}: ${entity.route}`);
    }
    return 0;
  }

  if (!options.out) {
    console.error('Fuer einen Bau wird --out <zielordner> benoetigt. Nur der Plan geht ohne Ziel (--plan).');
    return 2;
  }

  const result = await runFullstackBuild({
    request: options.request,
    outDir: resolve(options.out),
    projectName: options.name,
    maxRepairs: options.repairs,
    commit: options.commit,
    sink: options.json ? undefined : event => console.log(`[${event.type}] ${event.phase || ''} ${event.ok ? 'ok' : 'FEHLER'}`),
  });

  if (options.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      project: result.project,
      root: result.root,
      files: result.files.length,
      tests: { passed: result.verification?.testsPassed, failed: result.verification?.testsFailed },
      repairs: result.patches.length,
      checkpoints: result.checkpoints.length,
      commit: result.commit,
      failure: result.failure || null,
    }, null, 2));
  } else {
    console.log('');
    console.log(result.ok ? 'Bau verifiziert.' : 'Bau NICHT verifiziert.');
    console.log(`  Ziel:        ${result.root}`);
    console.log(`  Dateien:     ${result.files.length}`);
    console.log(`  API-Tests:   ${result.verification?.testsPassed ?? 0} bestanden, ${result.verification?.testsFailed ?? 0} fehlgeschlagen`);
    console.log(`  Reparaturen: ${result.patches.length}`);
    console.log(`  Checkpoints: ${result.checkpoints.length}`);
    console.log(`  Commit:      ${result.commit || result.commitNote || 'kein Commit'}`);
    if (result.failure) console.log(`  Grund:       ${result.failure.code} (${result.failure.phase})`);
  }
  return result.ok ? 0 : 1;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error('Full-Stack-Bau abgebrochen:', error?.message || error);
    process.exit(1);
  });
