/**
 * Liefer-Artefakte fuer Medien-Produkte (Video, Audio, Bild).
 *
 * Der Build konnte bisher nur apk/zip/tar.gz ausliefern. Ein Medien-Produkt
 * braucht die echte Datei - und zwar geprueft: eine umbenannte Textdatei oder
 * eine 0-Byte-Datei ist kein Produkt.
 */
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {extname, join, resolve} from 'node:path';

// dist/build bleiben sichtbar: der lokale Renderer legt sein Video dort ab.
const SKIP_DIRS = new Set(['node_modules', '.git', '.expo', 'coverage', '__pycache__', '.venv', 'venv']);

const MAGIC = ({
  '.mp4': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.m4v': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.mov': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.webm': (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  '.wav': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE',
  '.mp3': (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  '.ogg': (b) => b.subarray(0, 4).toString('latin1') === 'OggS',
  '.m4a': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.aac': (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0,
  '.flac': (b) => b.subarray(0, 4).toString('latin1') === 'fLaC',
  '.png': (b) => b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG',
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.svg': (b) => /<svg[\s>]/i.test(b.subarray(0, 4096).toString('utf8')),
  '.tif': (b) => b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && ((b[2] === 0x2a && b[3] === 0x00) || (b[2] === 0x2b && b[3] === 0x00))) || (b[0] === 0x4d && b[1] === 0x4d && ((b[2] === 0x00 && b[3] === 0x2a) || (b[2] === 0x00 && b[3] === 0x2b))))
});
MAGIC['.jpeg'] = MAGIC['.jpg'];
MAGIC['.tiff'] = MAGIC['.tif'];
Object.freeze(MAGIC);

export const MEDIA_MIN_BYTES = 1024;

/** Ist der Inhalt wirklich das Format, das die Endung behauptet? */
export function isPlayableArtifact(bytes, extension) {
  const buffer = Buffer.from(bytes || []);
  if (buffer.length < MEDIA_MIN_BYTES) return false;
  const check = MAGIC[String(extension || '').toLowerCase()];
  if (!check) return false;
  try { return check(buffer); } catch { return false; }
}

export function isMediaExtension(extension) {
  return Object.hasOwn(MAGIC, String(extension || '').toLowerCase());
}

/** Alle Medien-Dateien im Projekt, neueste zuerst (Build-Ausgaben ausgenommen). */
export function listMediaFiles(dir, extensions) {
  const wanted = new Set((extensions || []).map((e) => e.toLowerCase()));
  const root = resolve(dir);
  const found = [];
  const walk = (current, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(current, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!wanted.has(ext)) continue;
      let stats;
      try { stats = statSync(full); } catch { continue; }
      found.push({path: full, extension: ext, bytes: stats.size, modified: stats.mtimeMs});
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.modified - a.modified);
}

/**
 * Sucht das neueste echte Medien-Artefakt. Gibt null zurueck, wenn es keins
 * gibt - der Aufrufer meldet dann einen klaren Blocker statt eines Scheinerfolgs.
 */
export function findMediaArtifact(dir, extensions, {maxBytes = 512 * 1024 * 1024} = {}) {
  for (const file of listMediaFiles(dir, extensions)) {
    if (file.bytes > maxBytes) continue;
    let bytes;
    try { bytes = readFileSync(file.path); } catch { continue; }
    if (!isPlayableArtifact(bytes, file.extension)) continue;
    return file;
  }
  return null;
}
