import {createHash} from 'node:crypto';
import { recordBuildResult } from './telemetry.mjs';
import { projectDirectory,verifyProjectRuntime } from './project-verification.mjs';
/*
 * Produkt-Build-Pipeline (v1): Jede Villa liefert ein herunterladbares
 * Artefakt, sobald ihr Projekt bauereif ist.
 *  - Android-Projekt (gradlew): echter Gradle-APK-Build, sofern ANDROID_HOME
 *    auf dem Hub-Server gesetzt ist; sonst klarer Blocker-Hinweis.
 *  - Expo/Node/Web: Abhaengigkeiten + Buildskript, danach das Projekt als
 *    ZIP-Paket (tar.gz-Fallback, wenn kein zip-Programm existiert).
 *  - Sonst: Projekt als ZIP-Paket.
 * Der Status lebt in server/data/builds/state.json, Artefakte in
 * server/data/builds/. Beim Erreichen der Beta-Reife (Score >= 65) baut der
 * Hub automatisch einmalig mit (maybeAutoBuild, getaktet vom Rat-Loop).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, now } from './db.mjs';
import { maturity } from './product.mjs';

const run = promisify(execFile);
const DATA = resolve(process.cwd(), 'server/data');
const OUT = join(DATA, 'builds');
mkdirSync(OUT, { recursive: true });
const STATE = join(OUT, 'state.json');

// v1.42.0 — APK-Bereitstellung (Nutzerdirektive 2026-10-18): "die APK zur
// Verfuegung stellen". Sobald eine Villa alle Aufgaben erledigt hat, triggert
// der Hub die APK-Baustrasse (villa-apk.yml) einmalig je 20 Stunden je Villa.
// Die fertige APK erscheint als GitHub-Release villa-<id>-<datum>.
const APK_DELIVERY_REPO = process.env.VF_APK_PIPELINE_REPO || 'niknight1403/Agentforge2';
const APK_DELIVERY_LOG = join(OUT, 'apk-delivery.json');

export async function maybeDeliverApk(villaId, L = () => {}) {
  const open = db
    .prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY','RUNNING')")
    .get(villaId).c;
  if (open > 0) return { delivered: false, reason: 'open_tasks' };
  const v = db.prepare('SELECT id, name FROM villas WHERE id = ?').get(villaId);
  if (!v) return { delivered: false, reason: 'no_villa' };
  // Cooldown-Marker: max. eine APK-Delivery je Villa je 20 Stunden.
  let marker = {};
  try { marker = JSON.parse(readFileSync(APK_DELIVERY_LOG, 'utf8')); } catch { /* noch keine Delivery */ }
  const last = marker[String(villaId)] ? Date.parse(marker[String(villaId)]) : 0;
  if (Date.now() - last < 20 * 3600_000) return { delivered: false, reason: 'cooldown' };
  const token = resolveKey('GITHUB_TOKEN');
  if (!token) return { delivered: false, reason: 'no_token' };
  const d = await ghFetch(`/repos/${APK_DELIVERY_REPO}/actions/workflows/villa-apk.yml/dispatches`, token, {
    method: 'POST',
    body: JSON.stringify({
      ref: 'main',
      inputs: { villa_id: String(villaId), app_name: v.name || `Villa ${villaId}` }
    })
  });
  if (d.status !== 204) throw new Error(`APK-Dispatch fehlgeschlagen (HTTP ${d.status}): ${(await d.text()).slice(0, 200)}`);
  marker[String(villaId)] = new Date().toISOString();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(APK_DELIVERY_LOG, JSON.stringify(marker, null, 2));
  L(`APK-Baustrasse fuer Villa ${villaId} (${v.name}) angestossen - APK kommt als GitHub-Release.`);
  return { delivered: true };
}

let state = {};
try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { state = {}; }
function save() { writeFileSync(STATE, JSON.stringify(state, null, 2)); }

/**
 * Projektordner der Villa: der eigene Workspace, sofern er echte Projektdateien
 * enthaelt (mehr als die Backup-Ordner), sonst das hinterlegte Quellprojekt
 * (villas.source_path, z. B. ein per Git geklones Repository).
 */
export function villaDir(villaId) {return projectDirectory(Number(villaId));}

/** Projektart am Dateisystem erkennen. */
export function detectProject(dir) {
  if (!existsSync(dir)) return 'empty';
  if (existsSync(join(dir, 'gradlew'))) return 'android';
  if (existsSync(join(dir, 'android', 'gradlew'))) return 'android-cloud';
  if (existsSync(join(dir, 'app', 'src', 'main', 'AndroidManifest.xml')) || existsSync(join(dir, 'app', 'build.gradle.kts')) || existsSync(join(dir, 'app', 'build.gradle'))) return 'android-cloud';
  if (existsSync(join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.expo || deps['react-native'] || existsSync(join(dir, 'app.json')) && deps.expo) return 'expo';
    } catch { /* ungueltiges package.json -> generic */ }
    return 'node';
  }
  return 'generic';
}

async function sh(cmd, args, opts, L) {
  try {
    const r = await run(cmd, args, { maxBuffer: 12 * 1024 * 1024, timeout: 15 * 60 * 1000, ...opts });
    if (r.stdout) L(String(r.stdout).trim().slice(-400));
    if (r.stderr) L(String(r.stderr).trim().slice(-200));
    return true;
  } catch (e) {
    L(`FEHLER bei ${cmd} ${args.join(' ')}: ${String(e.message || e).slice(0, 300)}`);
    throw e;
  }
}

export function buildStatus(villaId) {
  return state[String(villaId)] || { status: 'none' };
}

export function buildArtifact(villaId) {
  const rec = buildStatus(villaId);
  if (!['ready','unverified'].includes(rec.status) || !rec.artifact) return null;
  const file = join(OUT, rec.artifact);
  if (!existsSync(file)) return null;
  return {
    file, name: rec.artifact,
    mime: rec.artifactType === 'apk' ? 'application/vnd.android.package-archive'
      : rec.artifactType === 'tar.gz' ? 'application/gzip' : 'application/zip'
  };
}


/* ---------- Cloud-APK-Build ueber GitHub Actions ----------
 * Der Hub-Server hat weder JDK noch Android-SDK. Statt lokal zu bauen,
 * loest er den APK-Workflow des Villa-Repos aus, wartet auf das Ergebnis
 * und legt die installierbare APK als Artefakt ab.
 * Benoetigt das Hub-Secret GITHUB_TOKEN (Scopes: repo, workflow). */
import { resolveKey } from './llm.mjs';
const GH = 'https://api.github.com';

async function ghFetch(path, token, init = {}) {
  const res = await fetch(GH + path, {
    redirect: 'follow',
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'villaforge-hub', ...(init.headers || {}) }
  });
  return res;
}

/** owner/repo aus dem origin-Remote des Villa-Projekts lesen. */
async function repoOf(dir) {
  const r = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 15000 });
  const m = String(r.stdout).trim().match(/github\.com[:/]+([^/]+)\/([^/.\s]+)(?:\.git)?$/i);
  if (!m) throw new Error('Kein GitHub-Remote im Villa-Projekt gefunden.');
  return { owner: m[1], repo: m[2] };
}

/** Findet den APK-Workflow des Repos (Datei mit apk im Namen, sonst "Build Android APK"). */
async function findApkWorkflow(owner, repo, token) {
  const res = await ghFetch(`/repos/${owner}/${repo}/actions/workflows`, token);
  if (!res.ok) throw new Error(`Workflow-Liste nicht lesbar (HTTP ${res.status}). Token-Rechte pruefen.`);
  const list = (await res.json()).workflows || [];
  const pick = list.find((w) => /apk/i.test(w.path) && !/aab|release-aab/i.test(w.path)) || list.find((w) => /apk|android/i.test(w.name));
  if (!pick) throw new Error('Das Repo hat keinen APK-Workflow (.github/workflows/*apk*.yml). Die Villa muss zuerst einen anlegen.');
  return pick;
}

async function cloudApkBuild(villaId, dir, L, record) {
  const token = resolveKey('GITHUB_TOKEN');
  if (!token) throw new Error('Hub-Secret GITHUB_TOKEN fehlt - fuer Cloud-APK-Builds ueber GitHub Actions hinterlegen.');
  const { owner, repo } = await repoOf(dir);
  const wf = await findApkWorkflow(owner, repo, token);
  L(`Cloud-Build: ${owner}/${repo} -> ${wf.path}`);

  // aktuellen Branch + letzten HEAD bestimmen, damit der Lauf zum Stand der Villa passt
  const branch = String((await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 15000 })).stdout).trim() || 'main';
  const before = Date.now() - 5000;
  const d = await ghFetch(`/repos/${owner}/${repo}/actions/workflows/${wf.id}/dispatches`, token, { method: 'POST', body: JSON.stringify({ ref: branch }) });
  if (d.status !== 204) throw new Error(`Workflow-Start fehlgeschlagen (HTTP ${d.status}): ${(await d.text()).slice(0, 200)}`);
  L('GitHub-Actions-Lauf gestartet - warte auf Ergebnis ...');

  // Lauf finden und bis zu 25 Minuten pollen
  let runInfo = null;
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const rr = await ghFetch(`/repos/${owner}/${repo}/actions/workflows/${wf.id}/runs?event=workflow_dispatch&per_page=5`, token);
    if (!rr.ok) continue;
    const cand = ((await rr.json()).workflow_runs || []).find((x) => new Date(x.created_at).getTime() >= before);
    if (cand) { runInfo = cand; if (cand.status === 'completed') break; }
  }
  if (!runInfo) throw new Error('Kein GitHub-Actions-Lauf gefunden.');
  if (runInfo.status !== 'completed') throw new Error('Cloud-Build dauert zu lange (>25 Min).');
  if (runInfo.conclusion !== 'success') throw new Error(`Cloud-Build fehlgeschlagen (${runInfo.conclusion}): ${runInfo.html_url}`);
  L(`Cloud-Build erfolgreich: ${runInfo.html_url}`);

  const ar = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${runInfo.id}/artifacts`, token);
  const arts = (await ar.json()).artifacts || [];
  const art = arts.find((a) => /apk/i.test(a.name) && /debug|release/i.test(a.name) && !/mapping/i.test(a.name)) || arts.find((a) => /apk/i.test(a.name)) || arts[0];
  if (!art) throw new Error('Der Lauf hat kein APK-Artefakt hochgeladen.');
  const zres = await ghFetch(`/repos/${owner}/${repo}/actions/artifacts/${art.id}/zip`, token);
  if (!zres.ok) throw new Error(`Artefakt-Download fehlgeschlagen (HTTP ${zres.status}).`);
  const tmpZip = join(OUT, `villa-${villaId}-artifact.zip`);
  writeFileSync(tmpZip, Buffer.from(await zres.arrayBuffer()));

  // APK(s) aus dem Artefakt-ZIP extrahieren (python3, kein unzip noetig)
  const apkOut = join(OUT, `villa-${villaId}.apk`);
  const py = [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'apks = [n for n in z.namelist() if n.lower().endswith(".apk")]',
    'apks.sort(key=lambda n: (("debug" not in n.lower()), n))',
    'if not apks: sys.exit(3)',
    'open(sys.argv[2], "wb").write(z.read(apks[0]))',
    'print(apks[0])'
  ].join('\n');
  const ex = await run('python3', ['-c', py, tmpZip, apkOut], { timeout: 60000 });
  L(`APK extrahiert: ${String(ex.stdout).trim()}`);
  // Plausibilitaet: gueltiges ZIP mit AndroidManifest.xml + classes.dex
  const chk = await run('python3', ['-c', 'import sys,zipfile;n=zipfile.ZipFile(sys.argv[1]).namelist();assert "AndroidManifest.xml" in n and any(x.endswith(".dex") for x in n);print("ok")', apkOut], { timeout: 30000 });
  if (!String(chk.stdout).includes('ok')) throw new Error('Extrahierte Datei ist keine gueltige APK.');
  record.artifactType = 'apk';
  record.artifact = `villa-${villaId}.apk`;
  record.cloudRun = runInfo.html_url;
  L('Installierbare APK geprueft (Manifest + Code vorhanden).');
}

/** Startet (asynchron) einen Produkt-Build fuer die Villa. */
/**
 * Phase 3 - Performance-Q-Gate (Studio-Konzept): Ein Build wird nicht nur
 * gepackt, sondern vermessen. Das Manifest landet im Build-Status (App
 * lesbar) und im Log; Ueberschreitungen des Asset-Budgets werden als
 * Warnung sichtbar, damit grosse Audio-/Bild-Assets frueh komprimiert
 * werden statt die Performance im Feld zu ruinieren.
 */
function perfManifest(dir, record, L) {
  try {
    const skip = new Set(['node_modules', '.git', '.gradle', 'app', 'build']);
    let files = 0, bytes = 0, audio = 0, largest = null;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = join(cur, e.name);
        if (e.isDirectory()) { if (!skip.has(e.name)) stack.push(p); continue; }
        let sz = 0;
        try { sz = statSync(p).size; } catch { continue; }
        files++; bytes += sz;
        if (/\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(e.name)) audio++;
        if (!largest || sz > largest.size) largest = { file: basename(p), size: sz };
      }
    }
    const webBuild = ['dist', 'out', 'public'].some((r) => existsSync(join(dir, r, 'index.html')));
    record.perf = { files, bytes, audioFiles: audio, largest, webBuild };
    L(`Performance-Manifest: ${files} Dateien, ${(bytes / 1024).toFixed(0)} KB, ${audio} Audio-Asset(s), ${webBuild ? 'Web-Build vorhanden' : 'kein Web-Build'}.`);
    if (largest && largest.size > 2 * 1024 * 1024) {
      record.perf.warn = `Performance-Budget ueberschritten: ${largest.file} ist ${(largest.size / 1024 / 1024).toFixed(1)} MB (> 2 MB) - Asset komprimieren.`;
      L('WARNUNG: ' + record.perf.warn);
    }
  } catch (e) {
    L('Performance-Manifest fehlgeschlagen: ' + String(e.message || e).slice(0, 120));
  }
}

// --- App-Geruest -----------------------------------------------------------
// Die Vorlage villa-apk-template/ lag ungenutzt im Repo: Villen erzeugten
// Wissensdatenbanken und Tests, aber nie einen Einstiegspunkt. Das Produkt-Gate
// verlangt index.html, package.json oder AndroidManifest.xml - ohne Geruest
// scheiterte jede Produktabnahme, obwohl die Villa fertig war.
const APP_ENTRY = /^(?:index\.html|package\.json|AndroidManifest\.xml)$/;
const SCAFFOLD_SKIP = new Set(['node_modules', '.git', '.gradle', 'backups', '__pycache__']);

function walkProject(dir, visit, level = 0, maxLevel = 8) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && visit(full, entry.name, level)) return true;
    if (entry.isDirectory() && level < maxLevel && !SCAFFOLD_SKIP.has(entry.name) && walkProject(full, visit, level + 1, maxLevel)) return true;
  }
  return false;
}

/** Traegt das Projekt irgendwo einen App-Einstiegspunkt? */
export function hasAppEntryPoint(dir) {
  if (!existsSync(dir)) return false;
  return walkProject(dir, (_full, name) => APP_ENTRY.test(name));
}

function shellPage(villa, dir) {
  const files = [];
  walkProject(dir, (full, name) => {
    let size = 0;
    try { size = statSync(full).size; } catch { /* Groesse optional */ }
    files.push({ name, size });
    return false;
  });
  const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = files.slice(0, 80).map((f) => `<li><code>${escape(f.name)}</code><span>${(f.size / 1024).toFixed(1)} KB</span></li>`).join('');
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(villa.name)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:24px;background:#0A0E14;color:#E6F1F5;font:16px/1.5 system-ui,sans-serif}
h1{margin:0 0 4px;font-size:24px;color:#00FFD1}
p.sub{margin:0 0 20px;color:#7F92A0;font-size:14px}
h2{margin:24px 0 8px;font-size:15px;color:#7F92A0;text-transform:uppercase;letter-spacing:.08em}
ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
li{display:flex;justify-content:space-between;gap:16px;background:#111823;border:1px solid #1E2A38;border-radius:10px;padding:10px 14px}
code{color:#00FFD1;font-size:14px;word-break:break-all}
li span{color:#7F92A0;font-size:13px;white-space:nowrap}
</style></head>
<body>
<h1>${escape(villa.name)}</h1>
<p class="sub">Villa ${escape(villa.id)} &middot; Projektstand ${escape(new Date(now()).toISOString().slice(0, 10))}</p>
<h2>Projektdateien (${files.length})</h2>
<ul>${rows || '<li>Noch keine Projektdateien</li>'}</ul>
</body></html>
`;
}

/**
 * Legt das App-Geruest aus villa-apk-template/ ins Projekt, wenn keins da ist.
 * Die Startseite zeigt den Inhalt der Villa statt eines Platzhalters.
 */
export function scaffoldAppShell(villa, dir, L = () => {}) {
  const source = join(process.cwd(), 'villa-apk-template');
  if (!existsSync(source)) { L('App-Vorlage villa-apk-template/ fehlt - kein Geruest ergaenzt.'); return false; }
  const target = join(dir, 'app-shell');
  const manifest = join(target, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (existsSync(manifest)) { L('App-Geruest app-shell/ ist bereits vorhanden.'); return true; }
  cpSync(source, target, { recursive: true });
  const page = join(target, 'app', 'src', 'main', 'assets', 'www', 'index.html');
  writeFileSync(page, shellPage(villa, dir), 'utf8');
  L('App-Geruest aus der Vorlage ergaenzt: app-shell/ mit AndroidManifest.xml und index.html.');
  return true;
}

export async function startBuild(villaId, { auto = false } = {}) {
  const villa = db.prepare('SELECT id, name FROM villas WHERE id = ?').get(Number(villaId));
  if (!villa) throw new Error('Villa nicht gefunden');
  const old = state[String(villaId)];
  if (old && old.status === 'running') throw new Error('BUILD_LAEUFT');
  const dir = villaDir(villaId);
  const kind = detectProject(dir);
  const record = { status: 'running', kind, auto: !!auto, startedAt: now(), log: [`Villa "${villa.name}" - Bauprojekt erkannt: ${kind}`] };
  state[String(villaId)] = record;
  save();

  (async () => {
    const L = (s) => { record.log.push(String(s).slice(0, 400)); if (record.log.length > 60) record.log.shift(); save(); };
    try {
      // Ohne Einstiegspunkt ist das Paket kein Produkt: Geruest aus der Vorlage.
      if (kind !== 'empty' && !hasAppEntryPoint(dir)) {
        record.scaffold = scaffoldAppShell(villa, dir, L);
      }
      // Build-Modus entscheiden: Cloud-APK braucht ein Git-Remote im
      // Workspace; ohne Remote faellt der Build sauber auf ein Produkt-Paket
      // zurueck, statt komplett zu scheitern (Studio-Phase-2-Fix).
      let mode = null;
      if (kind === 'android' && process.env.ANDROID_HOME) mode = 'local-apk';
      else if (kind === 'android' || kind === 'android-cloud') mode = 'cloud-apk';
      else if (kind !== 'empty') mode = 'package';
      if (mode === 'cloud-apk') {
        const hasRemote = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 15000 }).then(() => true).catch(() => false);
        if (hasRemote) {
          await cloudApkBuild(villaId, dir, L, record);
        } else {
          mode = 'package';
          record.kind = 'generic';
          L('Kein Git-Remote im Workspace - Cloud-APK nicht moeglich, baue stattdessen ein Produkt-Paket.');
        }
      }
      if (mode === 'local-apk') {
        await sh('sh', ['./gradlew', 'assembleDebug', '--console=plain'], { cwd: dir }, L);
        copyFileSync(join(dir, 'app/build/outputs/apk/debug/app-debug.apk'), join(OUT, `villa-${villaId}.apk`));
        record.artifactType = 'apk';
        record.artifact = `villa-${villaId}.apk`;
        L('APK gebaut.');
      }
      if (mode === 'package') {
        if (kind === 'node' || kind === 'expo') {
          let installed = await sh('npm', ['ci', '--no-audit', '--fund=false'], { cwd: dir }, L).catch(() => false);
          if (installed === false) installed = await sh('npm', ['install', '--no-audit', '--fund=false', '--legacy-peer-deps'], { cwd: dir }, L).catch(() => false);
          if (installed === false) throw new Error('Abhängigkeiten konnten nicht installiert werden; kein fertiges Produkt.');
          if (installed !== false) {
            try {
              const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
              if (pkg.scripts && pkg.scripts.build) await sh('npm', ['run', 'build'], { cwd: dir }, L);
            } catch { throw new Error('Buildskript fehlgeschlagen oder package.json ungültig; kein fertiges Produkt.'); }
          }
        }
        // Echtes ZIP mit sichtbarem Projektordner (Android-Entpacker zeigen './'-Pfade sonst nicht an)
        const pyZip = [
          'import os, sys, zipfile',
          'out, root = sys.argv[1], sys.argv[2]',
          "skip = {'node_modules', '.git', '.gradle', 'build'}",
          'base = os.path.basename(os.path.abspath(root))',
          'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
          '    for dp, dns, fns in os.walk(root):',
          '        dns[:] = [d for d in dns if d not in skip]',
          '        for f in fns:',
          '            p = os.path.join(dp, f)',
          '            z.write(p, os.path.join(base, os.path.relpath(p, root)))'
        ].join('\n');
        let artifactType = 'zip';
        try {
          await sh('python3', ['-c', pyZip, join(OUT, `villa-${villaId}.zip`), dir], { cwd: dir }, L);
        } catch {
          await sh('tar', ['czf', join(OUT, `villa-${villaId}.tar.gz`), '--exclude=node_modules', '--exclude=.git', '.'], { cwd: dir }, L);
          artifactType = 'tar.gz';
        }
        record.artifactType = artifactType;
        record.artifact = artifactType === 'tar.gz' ? `villa-${villaId}.tar.gz` : `villa-${villaId}.zip`;
        if (kind === 'expo') L('Hinweis: Expo-Projekt - echte APK via "npx eas build -p android" aus dem Paket (EAS-Konto noetig).');
        L('Produkt-Paket bereit.');
      }
      if (!mode) throw new Error('Villa-Workspace ist leer - erst Entwicklungsaufgaben ausfuehren lassen.');
      if (mode) perfManifest(dir, record, L); // Phase 3: vermessen statt nur bauen
      const verification=await verifyProjectRuntime(Number(villaId));
      record.verification=verification;
      record.delivery=verification.ok?'verified-product':'source-package';
      record.status = verification.ok ? 'ready' : 'unverified';
      if(!verification.ok)record.error='Paket erstellt, Produktabnahme offen: '+verification.blockers.join('; ');
    } catch (e) {
      record.status = 'failed';
      record.error = String(e.message || e).slice(0, 400);
      L(`ABGEBROCHEN: ${record.error}`);
    }
    record.finishedAt = now();
    // Telemetrie: jedes Build-Ergebnis dauerhaft festhalten, damit
    // build_green_rate und time_to_first_working messbar sind.
    try {
      recordBuildResult({
        villaId: Number(villaId),
        status: record.status,
        ok: record.status === 'ready',
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        error: record.error || ''
      });
    } catch { /* Telemetrie stoert keinen Build */ }
    if (record.artifact && record.status === 'ready') {
      try { record.sizeBytes = statSync(join(OUT, record.artifact)).size; } catch { /* Groesse optional */ }
    }
    save();
  })();

  return { ...record };
}

/** Autonomer Trigger: ab Beta-Reife (Score >= 65) einmalig ein Paket bauen. */
export function maybeAutoBuild(villaId, { threshold = 65 } = {}) {
  try {
    const rec = state[String(villaId)];
    if (rec && (rec.status === 'running' || rec.autoBuilt && rec.status==='ready' || Date.now()-Number(rec.finishedAt||0)<300000)) return false;
    const mt = maturity(Number(villaId));
    if (!mt || mt.score < threshold) return false;
    startBuild(villaId, { auto: true }).catch(() => {});
    const r = state[String(villaId)];
    if (r) r.autoBuilt = true;
    save();
    return true;
  } catch { return false; }
}

/** Live-Vorschau-Info: Web-Build der Villa, falls vorhanden. */
export function previewInfo(villaId) {
  const dir = villaDir(villaId);
  for (const cand of ['dist/index.html', 'dist/public/index.html', 'build/index.html', 'out/index.html', 'public/index.html', 'index.html']) {
    if (existsSync(join(dir, cand))) {
      let revision='';
      try {
        const folder=cand.includes('/')?cand.slice(0,cand.lastIndexOf('/')):'';
        const hash=createHash('sha256');
        let count=0;
        function walk(folder,depth=0){
          if(depth>12||count>=2000)return;
          for(const name of readdirSync(folder).sort()){
            if(['node_modules','.git','.gradle','.venv','venv','backups'].includes(name)||name.startsWith('.env'))continue;
            const f=join(folder,name);let st;try{st=statSync(f);}catch{continue;}
            if(st.isDirectory())walk(f,depth+1);
            else if(st.isFile()){hash.update(f+':'+st.size+':'+st.mtimeMs);count++;}
            if(count>=2000)break;
          }
        }
        walk(join(dir,folder));
        revision=hash.digest('hex');
      }catch{}
      return { type: 'web', path: `/api/villas/${villaId}/preview/${cand}`,revision };
    }
  }
  return { type: 'none', hint: 'Noch keine Web-Vorschau. Sobald die Villa einen Web-Build erzeugt (npm run build / dist), erscheint hier die Live-Ansicht.' };
}

/** Statische Auslieferung der Live-Vorschau (nur innerhalb von dist/build/out/public). */
export function previewFile(villaId, rest) {
  const dir = villaDir(villaId);
  let decoded;try{decoded=decodeURIComponent(String(rest||''));}catch{return null;}
  const clean=decoded.replace(/\\/g,'/').split('/').filter(Boolean);
  if(!clean.length||clean.some(p=>p==='..'||p==='.'||p.startsWith('.env')))return null;
  let target;try{target=realpathSync(resolve(join(dir,...clean)));}catch{return null;}
  const root=realpathSync(dir);
  const allowed=['dist','build','out','public'].some(folder=>target.startsWith(join(root,folder)+'/')) || (clean.length===1&&clean[0]==='index.html'&&target===join(root,'index.html'));
  if(!allowed||!statSync(target).isFile())return null;
  return { file: target, mime: previewMime(target) };
}

function previewMime(file) {
  const map = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
  return map[extname(file).toLowerCase()] || 'application/octet-stream';
}
