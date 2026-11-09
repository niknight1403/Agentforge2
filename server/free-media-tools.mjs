/**
 * Kostenlose Bild- und Videowerkzeuge: erkennen, pruefen, benutzen.
 *
 * Die Villa darf keine Faehigkeit behaupten, die auf der Maschine nicht
 * existiert. Dieses Modul beantwortet deshalb zuerst die Frage "welches freie
 * Werkzeug ist hier wirklich da?" (Binary + Version) und fuehrt danach nur
 * Operationen aus, deren Ergebnis es pruefen kann (Datei existiert, Groesse
 * plausibel, ffprobe bestaetigt Streams).
 *
 * Bewusst lokal: keine Cloud, keine API-Keys, kein Netz. Grenzen: alles laeuft
 * in einem erlaubten Arbeitsverzeichnis, mit Timeout und ohne Shell-Interpolation.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;

export const FREE_MEDIA_TOOLS = Object.freeze([
  { id: 'ffmpeg', kind: 'video', bin: 'ffmpeg', args: ['-version'], purpose: 'Video schneiden, montieren, Text einblenden, Tonspur mischen' },
  { id: 'ffprobe', kind: 'video', bin: 'ffprobe', args: ['-version'], purpose: 'Video/Audio pruefen (Dauer, Streams, Aufloesung)' },
  { id: 'magick', kind: 'image', bin: 'magick', args: ['-version'], purpose: 'Bilder skalieren, zuschneiden, Farben, Wasserzeichen' },
  { id: 'convert', kind: 'image', bin: 'convert', args: ['--version'], purpose: 'Bildoperationen (ImageMagick 6 Fallback)' },
  { id: 'sox', kind: 'audio', bin: 'sox', args: ['--version'], purpose: 'Audio trimmen, normalisieren, Betten mischen' }
]);

const cache = new Map();

/** Ein Werkzeug ist nur verfuegbar, wenn das Binary startet und eine Version nennt. */
export async function probeTool(tool) {
  try {
    const { stdout, stderr } = await run(tool.bin, tool.args, { timeout: 10_000 });
    const text = `${stdout || ''}${stderr || ''}`.trim();
    const version = (text.split('\n')[0] || '').slice(0, 120) || null;
    return { id: tool.id, kind: tool.kind, available: true, version, purpose: tool.purpose };
  } catch (error) {
    return {
      id: tool.id,
      kind: tool.kind,
      available: false,
      version: null,
      purpose: tool.purpose,
      reason: error?.code === 'ENOENT' ? 'nicht_installiert' : String(error?.message || 'nicht_startbar').slice(0, 120)
    };
  }
}

export async function mediaToolInventory({ refresh = false } = {}) {
  if (!refresh && cache.size) return [...cache.values()];
  const results = await Promise.all(FREE_MEDIA_TOOLS.map((tool) => probeTool(tool)));
  cache.clear();
  for (const result of results) cache.set(result.id, result);
  return results;
}

/** Kandidat fuer eine Aufgabe: erstes verfuegbares Werkzeug der passenden Art. */
export async function pickTool(kind, { refresh = true } = {}) {
  const inventory = await mediaToolInventory({ refresh });
  return inventory.find((entry) => entry.kind === kind && entry.available) || null;
}

const MEDIA_ROOT = resolve(process.env.VF_MEDIA_DIR || join(process.cwd(), 'server/data/media'));

export function mediaRoot() {
  mkdirSync(MEDIA_ROOT, { recursive: true });
  return MEDIA_ROOT;
}

/** Nur Pfade innerhalb des Medienverzeichnisses sind erlaubt. */
export function safePath(input, { mustExist = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('PFAD_FEHLT');
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(MEDIA_ROOT, raw);
  if (!absolute.startsWith(MEDIA_ROOT)) throw new Error('PFAD_AUSSERHALB_MEDIENVERZEICHNIS');
  if (mustExist && !existsSync(absolute)) throw new Error(`DATEI_FEHLT:${basename(absolute)}`);
  return absolute;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi']);

function assertExtension(path, allowed) {
  const ext = extname(path).toLowerCase();
  if (!allowed.has(ext)) throw new Error(`FORMAT_NICHT_UNTERSTUETZT:${ext || 'ohne_endung'}`);
  return ext;
}

/** Ergebnis ehrlich pruefen: Datei da, nicht leer, optional per ffprobe bestaetigt. */
export async function verifyArtifact(outputPath, { minBytes = 1024, probe = false } = {}) {
  if (!existsSync(outputPath)) return { ok: false, reason: 'datei_fehlt' };
  const size = statSync(outputPath).size;
  if (size < minBytes) return { ok: false, reason: `zu_klein:${size}` };
  if (!probe) return { ok: true, bytes: size };
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', outputPath], { timeout: 30_000 });
    const info = JSON.parse(stdout || '{}');
    return { ok: true, bytes: size, probe: info.format || null };
  } catch (error) {
    return { ok: false, reason: `ffprobe_fehlgeschlagen:${String(error?.message || '').slice(0, 80)}`, bytes: size };
  }
}

/** Bild skalieren (freies Werkzeug, lokale Datei). */
export async function resizeImage({ input, output, width, height }) {
  const tool = await pickTool('image');
  if (!tool) return { ok: false, reason: 'kein_bildwerkzeug' };
  const src = safePath(input, { mustExist: true });
  assertExtension(src, IMAGE_EXT);
  const out = safePath(output);
  assertExtension(out, IMAGE_EXT);
  const w = Math.max(16, Math.min(Number(width) || 1080, 4096));
  const h = Math.max(16, Math.min(Number(height) || 1080, 4096));
  const args = tool.id === 'magick' ? [src, '-resize', `${w}x${h}!`, out] : [src, '-resize', `${w}x${h}!`, out];
  await run(tool.bin, args, { timeout: TIMEOUT_MS });
  return { tool: tool.id, output: out, ...(await verifyArtifact(out)) };
}

/** Bilder zu einem Video montieren (Ken-Burns-frei, ehrlich: Standbilder mit Dauer). */
export async function imagesToVideo({ images, output, secondsPerImage = 3, fps = 25 }) {
  const tool = await pickTool('video');
  if (!tool) return { ok: false, reason: 'kein_videowerkzeug' };
  if (!Array.isArray(images) || !images.length) throw new Error('KEINE_BILDER');
  const sources = images.map((entry) => safePath(entry, { mustExist: true }));
  for (const source of sources) assertExtension(source, IMAGE_EXT);
  const out = safePath(output);
  assertExtension(out, VIDEO_EXT);
  const per = Math.max(1, Math.min(Number(secondsPerImage) || 3, 30));
  const rate = Math.max(1, Math.min(Number(fps) || 25, 60));
  const list = sources.map((source) => `file '${source.replace(/'/g, "'\\''")}'`).join('\n');
  const listFile = join(mediaRoot(), `.concat-${Date.now()}.txt`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(listFile, `${list}\n`);
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=${rate}`,
    '-t', String(per * sources.length), '-pix_fmt', 'yuv420p', out
  ], { timeout: TIMEOUT_MS });
  return { tool: 'ffmpeg', output: out, ...(await verifyArtifact(out, { probe: true })) };
}

/** Standbild aus einem Video ziehen (Vorschau der Live-Ansicht). */
export async function videoThumbnail({ input, output, atSeconds = 1 }) {
  const src = safePath(input, { mustExist: true });
  assertExtension(src, VIDEO_EXT);
  const out = safePath(output);
  assertExtension(out, IMAGE_EXT);
  await run('ffmpeg', ['-y', '-ss', String(Math.max(0, Number(atSeconds) || 0)), '-i', src, '-frames:v', '1', out], { timeout: TIMEOUT_MS });
  return { tool: 'ffmpeg', output: out, ...(await verifyArtifact(out)) };
}

/** Text als Untertitel/Titel ins Video brennen (Regieanweisung sichtbar machen). */
export async function burnTitle({ input, output, text }) {
  const src = safePath(input, { mustExist: true });
  const out = safePath(output);
  assertExtension(out, VIDEO_EXT);
  const safeText = String(text ?? '').replace(/[\\':%]/g, ' ').slice(0, 120);
  if (!safeText.trim()) throw new Error('TEXT_FEHLT');
  await run('ffmpeg', [
    '-y', '-i', src, '-vf', `drawtext=text='${safeText}':x=(w-tw)/2:y=h-th-40:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5`,
    '-c:a', 'copy', out
  ], { timeout: TIMEOUT_MS });
  return { tool: 'ffmpeg', output: out, ...(await verifyArtifact(out, { probe: true })) };
}

/** Kurzbericht fuer die Live-Ansicht. */
export async function freeMediaStatus() {
  const inventory = await mediaToolInventory({ refresh: true });
  const available = inventory.filter((entry) => entry.available).map((entry) => entry.id);
  return {
    root: mediaRoot(),
    available,
    missing: inventory.filter((entry) => !entry.available).map((entry) => ({ id: entry.id, reason: entry.reason })),
    can: {
      image: available.includes('magick') || available.includes('convert'),
      video: available.includes('ffmpeg'),
      probe: available.includes('ffprobe'),
      audio: available.includes('sox')
    },
    note: 'Nur aufgelistete Werkzeuge sind vorhanden; alles andere wird als Luecke gemeldet statt angenommen.'
  };
}
