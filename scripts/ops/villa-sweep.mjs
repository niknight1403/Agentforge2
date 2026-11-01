#!/usr/bin/env node
/**
 * Villa-Sweep: nimmt blockierte Villen nacheinander mit echten Nachweisen ab.
 *
 * Ablauf je Villa:
 *  1. Stack erkennen (python / node / html)
 *  2. Fehlt ein gueltiger Build-Befehl oder wurde ein Platzhalter abgelehnt,
 *     wird ein echtes Build-Skript ins Projekt gelegt (kein Echo, keine Attrappe).
 *  3. Die echte Hub-Abnahme laeuft (build + tests + smoke + Qualitaet).
 *  4. Bestanden -> fertig. Sonst: Reparaturaufgabe mit dem genauen Befund und,
 *     solange das Limit nicht erreicht ist, Autonomie fuer genau diese Villa.
 *
 * Aufruf auf dem Server (cwd /opt/villaforge):
 *   node scripts/ops/villa-sweep.mjs [--limit=2] [--auto-max=3] [--dry-run]
 */
import {writeFileSync, existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

process.chdir('/opt/villaforge');
const {db, now} = await import('/opt/villaforge/server/db.mjs');
const {verifyProjectRuntime, projectDirectory, verificationPlan, inspectProject} = await import('/opt/villaforge/server/project-verification.mjs');

const arg = (name, fallback) => {
  const treffer = process.argv.find((a) => a.startsWith(`--${name}=`));
  return treffer ? treffer.split('=')[1] : fallback;
};
const LIMIT = Number(arg('limit', 2));
const AUTO_MAX = Number(arg('auto-max', 3));
const DRY = process.argv.includes('--dry-run');

const PY_BUILD = [
  '#!/usr/bin/env python3',
  '# Build-Nachweis: uebersetzt jede Python-Quelle und bricht bei Syntaxfehlern ab.',
  'import pathlib, sys',
  '',
  'ROOTS = sys.argv[1:] or ["."]',
  'SKIP = {"venv", ".venv", "node_modules", "__pycache__", ".git", "build", "dist"}',
  'fehler = 0',
  'geprueft = 0',
  'for wurzel in ROOTS:',
  '    basispfad = pathlib.Path(wurzel)',
  '    if not basispfad.exists():',
  '        print("Pfad fehlt: " + wurzel)',
  '        fehler += 1',
  '        continue',
  '    for datei in sorted(basispfad.rglob("*.py")):',
  '        if SKIP.intersection(datei.parts):',
  '            continue',
  '        geprueft += 1',
  '        try:',
  '            compile(datei.read_text(encoding="utf-8"), str(datei), "exec")',
  '        except SyntaxError as fehl:',
  '            fehler += 1',
  '            print("Syntaxfehler in " + str(datei) + ": " + str(fehl.msg) + " (Zeile " + str(fehl.lineno) + ")")',
  '        except UnicodeDecodeError:',
  '            fehler += 1',
  '            print("Nicht lesbar: " + str(datei))',
  'print(str(geprueft) + " Dateien uebersetzt, " + str(fehler) + " Fehler")',
  'if geprueft == 0:',
  '    print("Keine Python-Quellen gefunden - dieser Build prueft nichts und gilt nicht als Nachweis")',
  '    sys.exit(2)',
  'sys.exit(0 if fehler == 0 else 1)',
  ''
].join('\n');

const NODE_BUILD = [
  '#!/usr/bin/env node',
  '// Build-Nachweis: parst jede JS-Quelle mit dem echten Node-Parser.',
  'import {readdirSync} from "node:fs";',
  'import {join} from "node:path";',
  'import {execFileSync} from "node:child_process";',
  '',
  'const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".expo", "coverage", "android", "ios"]);',
  'const DATEIEN = [];',
  'function lauf(ordner, tiefe = 0) {',
  '  if (tiefe > 12) return;',
  '  for (const eintrag of readdirSync(ordner, {withFileTypes: true})) {',
  '    if (SKIP.has(eintrag.name)) continue;',
  '    const pfad = join(ordner, eintrag.name);',
  '    if (eintrag.isDirectory()) lauf(pfad, tiefe + 1);',
  '    else if (/\\.(mjs|cjs|js)$/.test(eintrag.name)) DATEIEN.push(pfad);',
  '  }',
  '}',
  'for (const wurzel of process.argv.slice(2).length ? process.argv.slice(2) : ["."]) lauf(wurzel);',
  'let fehler = 0;',
  'for (const datei of DATEIEN) {',
  '  try { execFileSync(process.execPath, ["--check", datei], {stdio: "pipe"}); }',
  '  catch (e) { fehler += 1; console.log("Syntaxfehler in " + datei + ": " + String(e.stderr || e.message).split("\\n").slice(0, 3).join(" ").slice(0, 200)); }',
  '}',
  'console.log(DATEIEN.length + " Dateien geparst, " + fehler + " Fehler");',
  'if (DATEIEN.length === 0) { console.log("Keine JS-Quellen gefunden - dieser Build prueft nichts und gilt nicht als Nachweis"); process.exit(2); }',
  'process.exit(fehler === 0 ? 0 : 1);',
  ''
].join('\n');

function stackVon(ordner) {
  if (!existsSync(ordner)) return 'unbekannt';
  if (existsSync(join(ordner, 'requirements.txt')) || existsSync(join(ordner, 'pyproject.toml'))) return 'python';
  const pkg = join(ordner, 'package.json');
  if (existsSync(pkg)) {
    try {
      const inhalt = JSON.parse(readFileSync(pkg, 'utf8'));
      const alle = {...(inhalt.dependencies || {}), ...(inhalt.devDependencies || {})};
      if (alle.expo || alle['react-native']) return 'node-expo';
    } catch {}
    return 'node';
  }
  const pyDateien = readdirSync(ordner).filter((n) => n.endsWith('.py')).length;
  if (pyDateien) return 'python';
  if (existsSync(join(ordner, 'index.html'))) return 'html';
  return 'unbekannt';
}

function schreibeWennNoetig(pfad, inhalt, grund) {
  if (existsSync(pfad)) return false;
  writeFileSync(pfad, inhalt);
  console.log(`  ${grund}: ${pfad.split('/').pop()} angelegt`);
  return true;
}

/** Legt nur dann einen Build-Befehl an, wenn er fehlt oder als Platzhalter abgelehnt wird. */
function buildNachweis(id, ordner, stack) {
  let plan = {};
  try { plan = verificationPlan(ordner); } catch {}
  const build = plan.build;
  if (build && !build.invalid) {
    console.log(`  Build bereits vorhanden: ${[build.binary, ...build.args].join(' ')}`);
    return false;
  }
  if (build?.invalid) console.log(`  abgelehnter Build: ${String(build.invalid).slice(0, 140)}`);
  if (DRY) { console.log(`  [dry-run] wuerde Build fuer ${stack} anlegen`); return false; }

  let befehl;
  if (stack === 'python') {
    schreibeWennNoetig(join(ordner, 'villaforge_build.py'), PY_BUILD, 'Python-Build');
    befehl = {binary: 'python3', args: ['villaforge_build.py']};
  } else if (stack === 'node' || stack === 'node-expo') {
    schreibeWennNoetig(join(ordner, 'villaforge_build.mjs'), NODE_BUILD, 'Node-Build');
    befehl = {binary: 'node', args: ['villaforge_build.mjs']};
  } else {
    console.log('  kein Build-Nachweis fuer diesen Stack ableitbar');
    return false;
  }

  const ziel = join(ordner, 'villaforge.verify.json');
  let bestehend = {};
  try { bestehend = JSON.parse(readFileSync(ziel, 'utf8')); } catch {}
  bestehend.build = befehl;
  writeFileSync(ziel, JSON.stringify(bestehend, null, 2));
  console.log(`  Build gesetzt: ${befehl.binary} ${befehl.args.join(' ')}`);
  return true;
}

function reparaturAuftrag(id, blocker) {
  const titel = '[REPARATUR] Produktabnahme bestehen';
  const text = 'Der Sweep hat die Abnahme echt ausgefuehrt. Offene Befunde: ' + blocker.join('; ').slice(0, 900) +
    '. Behebe die Ursache im Projekt, nicht die Pruefung. Akzeptanz: build, test und smoke laufen am unveraenderten Quellstand erfolgreich.';
  const offen = db.prepare("SELECT id FROM tasks WHERE villa_id=? AND title=? AND status NOT IN ('DONE','FAILED')").get(id, titel);
  if (offen) {
    db.prepare('UPDATE tasks SET description=?, updated_at=? WHERE id=?').run(text, now(), offen.id);
    return offen.id;
  }
  const neu = db.prepare("INSERT INTO tasks(villa_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,'PENDING',1,?,?)").run(id, titel, text, now(), now());
  console.log(`  Reparaturaufgabe angelegt (id ${neu.lastInsertRowid})`);
  return Number(neu.lastInsertRowid);
}

function autonomieFreigeben(id, name) {
  const aktiv = db.prepare('SELECT COUNT(*) c FROM villas WHERE autonomy=1').get().c;
  if (aktiv >= AUTO_MAX) {
    console.log(`  Autonomie bleibt aus (${aktiv}/${AUTO_MAX} Villen aktiv)`);
    return false;
  }
  if (DRY) { console.log('  [dry-run] wuerde Autonomie freigeben'); return false; }
  db.prepare("UPDATE villas SET autonomy=1, updated_at=? WHERE id=?").run(now(), id);
  console.log(`  Autonomie freigegeben (${aktiv + 1}/${AUTO_MAX}): ${name}`);
  return true;
}

// ---- Auswahl: nie geprueft oder zuletzt blockiert, kleinste Id zuerst ----
const kandidaten = db.prepare(`
  SELECT v.id, v.name, v.status, v.autonomy,
         (SELECT status FROM project_verifications p WHERE p.villa_id = v.id) AS pruefung,
         (SELECT fingerprint FROM project_verifications p WHERE p.villa_id = v.id) AS stand,
         (SELECT COUNT(*) FROM tasks t WHERE t.villa_id = v.id AND t.status IN ('PENDING','RUNNING')) AS offen
  FROM villas v
  WHERE v.status NOT IN ('ARCHIVED','COMPLETED')
    AND COALESCE((SELECT status FROM project_verifications p WHERE p.villa_id = v.id), 'offen') != 'passed'
  ORDER BY COALESCE((SELECT verified_at FROM project_verifications p WHERE p.villa_id = v.id), 0) ASC, v.id
`).all();

console.log(`== SWEEP: ${kandidaten.length} Villen offen, diese Runde ${Math.min(LIMIT, kandidaten.length)} (limit=${LIMIT}, auto-max=${AUTO_MAX}) ==`);

let abgenommen = 0;
let bearbeitet = 0;
for (const villa of kandidaten) {
  if (bearbeitet >= LIMIT) break;
  const ordner = projectDirectory(villa.id);
  const stack = stackVon(ordner);
  console.log(`\n-- Villa ${villa.id} "${villa.name}" | ${stack} | bisher ${villa.pruefung} | ${villa.offen} offene Aufgaben`);
  if (stack === 'unbekannt') {
    // Ohne Quelldateien gibt es nichts abzunehmen; das soll aber kein Kontingent verbrauchen.
    reparaturAuftrag(villa.id, ['Projektordner enthaelt keine pruefbaren Quellen - Implementierung fehlt']);
    console.log('  Projektordner fehlt oder ist leer - Reparaturaufgabe notiert, naechste Villa');
    continue;
  }
  const jetztStand = inspectProject(villa.id);
  if (jetztStand.fingerprint && jetztStand.fingerprint === villa.stand && !DRY) {
    console.log('  Quellstand unveraendert seit der letzten Abnahme - uebersprungen');
    continue;
  }
  bearbeitet += 1;
  buildNachweis(villa.id, ordner, stack);
  if (DRY) continue;

  let ergebnis;
  try {
    ergebnis = await verifyProjectRuntime(villa.id);
  } catch (e) {
    console.log(`  Abnahme nicht ausfuehrbar: ${e.message}`);
    continue;
  }
  const befunde = Object.entries(ergebnis.checks || {})
    .filter(([, v]) => v.status !== 'passed')
    .map(([kind, v]) => `${kind}: ${String(v.reason || v.status).slice(0, 200)}`);
  for (const [kind, v] of Object.entries(ergebnis.checks || {})) {
    console.log(`  ${kind}: ${v.status}${v.reason ? ' - ' + String(v.reason).slice(0, 150) : ''}`);
  }
  if (ergebnis.ok) {
    abgenommen += 1;
    console.log('  ERGEBNIS: abgenommen');
    continue;
  }
  const eigenverschulden = befunde.filter((b) => /^tests: failed|^quality:/.test(b) || /Syntaxfehler/.test(b));
  const blocker = eigenverschulden.length ? eigenverschulden : (ergebnis.blockers || []).slice(0, 4);
  reparaturAuftrag(villa.id, blocker);
  autonomieFreigeben(villa.id, villa.name);
}

const stand = db.prepare("SELECT COUNT(*) c FROM project_verifications WHERE status='passed'").get().c;
const gesamt = db.prepare("SELECT COUNT(*) c FROM villas WHERE status NOT IN ('ARCHIVED','COMPLETED')").get().c;
console.log(`\n== STAND: ${stand} von ${gesamt} Villen abgenommen, diese Runde +${abgenommen} ==`);
