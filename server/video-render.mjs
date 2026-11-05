/**
 * Lokaler Video-Renderer fuer Villen mit Medien-Produkt (kostenlos, ffmpeg).
 *
 * Ohne konfigurierten Medienanbieter (fal) konnte eine Video-Villa nie ein
 * echtes Artefakt liefern: der Fallback schrieb nur Szenenliste und Skript.
 * Der Renderer baut aus einem deklarierten Manifest (villaforge.render.json)
 * eine abspielbare MP4 - Titel-Card, Szenen mit Text, optional Tonspur.
 *
 * Bewusst schlicht und deterministisch: kein Netz, keine KI, nur ffmpeg.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, extname} from 'node:path';

const run = promisify(execFile);

const FONT_CANDIDATES = Object.freeze([
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf'
]);

const DEFAULTS = Object.freeze({fps: 25, width: 1280, height: 720, sceneSeconds: 4, maxSecondsPerScene: 30});

export function renderManifestPath(dir) {
  const file = join(resolve(dir), 'villaforge.render.json');
  return existsSync(file) ? file : null;
}

function firstFont() {
  return FONT_CANDIDATES.find((f) => existsSync(f)) || null;
}

function wrap(text, maxChars = 46) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line.length) { line = word; continue; }
    if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line.length) lines.push(line);
  return lines.join('\n');
}

async function versionOk() {
  try { await run('ffmpeg', ['-version'], {timeout: 15000}); return true; } catch { return false; }
}

async function hasEncoder(name) {
  try {
    const {stdout} = await run('ffmpeg', ['-hide_banner', '-encoders'], {timeout: 15000});
    return new RegExp(`\\s${name}\\s`).test(stdout);
  } catch { return false; }
}

/** Manifest pruefen: nur erklaerte Felder, harte Grenzen. */
export function normalizeManifest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const scenes = Array.isArray(src.scenes) ? src.scenes : [];
  const width = Math.min(1920, Math.max(320, Number(src.width) || DEFAULTS.width));
  const height = Math.min(1080, Math.max(240, Number(src.height) || DEFAULTS.height));
  const fps = Math.min(60, Math.max(10, Number(src.fps) || DEFAULTS.fps));
  if (!scenes.length) throw new Error('RENDER_MANIFEST_EMPTY: das Manifest enthaelt keine Szenen.');
  if (scenes.length > 120) throw new Error('RENDER_MANIFEST_TOO_LARGE: maximal 120 Szenen.');
  const clean = scenes.map((scene, index) => {
    const text = String(scene?.text || '').slice(0, 600);
    if (!text.trim()) throw new Error(`RENDER_SCENE_EMPTY: Szene ${index + 1} hat keinen Text.`);
    const seconds = Math.min(DEFAULTS.maxSecondsPerScene, Math.max(1, Number(scene?.seconds) || DEFAULTS.sceneSeconds));
    const image = scene?.image ? String(scene.image) : null;
    if (image && (image.includes('..') || image.startsWith('/'))) throw new Error(`RENDER_SCENE_UNSAFE: Szene ${index + 1} verweist auf einen Pfad ausserhalb des Projekts.`);
    return {text, seconds, image};
  });
  const audio = src.audio ? String(src.audio) : null;
  if (audio && (audio.includes('..') || audio.startsWith('/'))) throw new Error('RENDER_AUDIO_UNSAFE: Tonspur liegt ausserhalb des Projekts.');
  const out = String(src.out || 'dist/video/villa-show.mp4');
  if (out.includes('..') || out.startsWith('/')) throw new Error('RENDER_OUT_UNSAFE: Zielpfad liegt ausserhalb des Projekts.');
  return {title: String(src.title || '').slice(0, 200), width, height, fps, scenes: clean, audio, out};
}

async function sceneClip(manifest, scene, index, font, codec, workdir) {
  const w = manifest.width, h = manifest.height;
  const textfile = join(workdir, `scene-${index}.txt`);
  writeFileSync(textfile, wrap(scene.text), 'utf8');
  const size = Math.round(h / 16);
  const filters = [
    `drawtext=fontfile=${font}:textfile=${textfile}:fontcolor=white:fontsize=${size}:line_spacing=${Math.round(size * 0.45)}:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black:shadowx=2:shadowy=2`
  ];
  const clip = join(workdir, `clip-${index}.mp4`);
  const args = ['-y'];
  if (scene.image) {
    const source = resolve(manifest.root, scene.image);
    if (!existsSync(source)) throw new Error(`RENDER_SCENE_IMAGE_MISSING: ${scene.image}`);
    args.push('-loop', '1', '-i', source);
    filters.unshift(`scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0e1116`);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=0x0e1116:s=${w}x${h}:d=${scene.seconds}`);
  }
  args.push('-t', String(scene.seconds), '-r', String(manifest.fps), '-vf', filters.join(','),
    '-c:v', codec, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip);
  await run('ffmpeg', args, {timeout: 120000, maxBuffer: 8 * 1024 * 1024});
  return clip;
}

/**
 * Rendert das Manifest zu einer MP4. Gibt {path, bytes, seconds, scenes} zurueck.
 * Fehlt ffmpeg, bricht der Aufruf mit einer klaren Meldung ab statt still zu bestehen.
 */
export async function renderVillaVideo(dir, manifestRaw, {log = () => {}} = {}) {
  const root = resolve(dir);
  const manifest = {...normalizeManifest(manifestRaw), root};
  if (!(await versionOk())) throw new Error('RENDER_TOOL_MISSING: ffmpeg ist auf diesem Rechner nicht installiert.');
  const font = firstFont();
  if (!font) throw new Error('RENDER_TOOL_MISSING: keine nutzbare Schriftdatei (DejaVu/Liberation) gefunden.');
  const codec = (await hasEncoder('libx264')) ? 'libx264' : 'mpeg4';
  const workdir = mkdtempSync(join(tmpdir(), 'vf-render-'));
  try {
    const clips = [];
    for (let i = 0; i < manifest.scenes.length; i++) {
      log(`Szene ${i + 1}/${manifest.scenes.length}`);
      clips.push(await sceneClip(manifest, manifest.scenes[i], i, font, codec, workdir));
    }
    const list = join(workdir, 'concat.txt');
    writeFileSync(list, clips.map((c) => `file '${c}'`).join('\n'), 'utf8');
    const silent = join(workdir, 'silent.mp4');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent], {timeout: 180000, maxBuffer: 8 * 1024 * 1024});
    let final = silent;
    if (manifest.audio) {
      const audio = resolve(root, manifest.audio);
      if (!existsSync(audio)) throw new Error(`RENDER_AUDIO_MISSING: ${manifest.audio}`);
      const mixed = join(workdir, 'mixed.mp4');
      const acodec = (await hasEncoder('aac')) ? 'aac' : 'copy';
      await run('ffmpeg', ['-y', '-i', silent, '-i', audio, '-c:v', 'copy', '-c:a', acodec, '-shortest', mixed], {timeout: 180000, maxBuffer: 8 * 1024 * 1024});
      final = mixed;
    }
    const target = join(root, manifest.out);
    mkdirSync(dirname(target), {recursive: true});
    copyFileSync(final, target);
    const bytes = statSync(target).size;
    if (bytes < 2048) throw new Error('RENDER_OUTPUT_EMPTY: die erzeugte Datei ist zu klein, um ein Video zu sein.');
    return {path: target, bytes, scenes: manifest.scenes.length, seconds: manifest.scenes.reduce((sum, s) => sum + s.seconds, 0), codec};
  } finally {
    rmSync(workdir, {recursive: true, force: true});
  }
}

export const VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.webm']);
export const videoExtension = (file) => VIDEO_EXTENSIONS.includes(extname(String(file || '')).toLowerCase());
