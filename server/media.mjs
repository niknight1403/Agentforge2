import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { isIP } from 'node:net';
import { db } from './db.mjs';
import { PROJECT_WORKSPACE } from './project-verification.mjs';

const MODELS = {
  image: process.env.VF_FAL_IMAGE_MODEL || 'fal-ai/flux/schnell',
  image_edit: process.env.VF_FAL_IMAGE_EDIT_MODEL || 'fal-ai/flux-kontext/dev',
  video: process.env.VF_FAL_VIDEO_MODEL || 'fal-ai/wan/v2.7/text-to-video',
  audio: process.env.VF_FAL_AUDIO_MODEL || 'minimax/music-3',
};
const CAPABILITIES = [
  { id: 'app_development', title: 'Apps entwickeln und bearbeiten', modes: ['code'], always: true, fallback: 'Lokale Projektwerkzeuge, Tests, Build- und Review-Schritte.' },
  { id: 'image_generation', title: 'Bilder erstellen', modes: ['image'], provider: 'fal', fallback: 'Ohne Medienanbieter werden Prompt und Asset-Spezifikation als Projektdatei vorbereitet.' },
  { id: 'image_editing', title: 'Bilder bearbeiten', modes: ['image_edit'], provider: 'fal', fallback: 'Ohne Medienanbieter werden Edit-Anweisung und reproduzierbarer Arbeitsauftrag vorbereitet.' },
  { id: 'video_generation', title: 'Videos erstellen', modes: ['video'], provider: 'fal', fallback: 'Ohne Medienanbieter werden Skript, Szenenliste, Shotlist und Untertitel als Dateien vorbereitet.' },
  { id: 'audio_generation', title: 'Audio und Musik erstellen', modes: ['audio'], provider: 'fal', fallback: 'Ohne Medienanbieter werden Lyrics, Arrangement, Tempo- und Sounddesign-Brief vorbereitet.' },
  { id: 'live_performance', title: 'Live-Performance-Software entwickeln', modes: ['code'], always: true, fallback: 'Projektwerkzeuge erzeugen und testen Audio-Engine, MIDI/WebAudio-Flows und Performance-UIs; echte Hardware-Ausgabe muss auf Zielgeräten geprüft werden.' },
];

function falKey() {
  return db.prepare("SELECT value FROM secrets WHERE name='FAL_KEY'").get()?.value || process.env.FAL_KEY || '';
}

export function mediaCapabilities() {
  const configured = Boolean(falKey());
  return CAPABILITIES.map((c) => ({
    id: c.id, title: c.title, modes: c.modes,
    status: c.always ? 'ready' : configured ? 'configured' : 'needs_provider',
    provider: c.provider || null,
    model: c.modes[0] === 'code' ? null : MODELS[c.modes[0]],
    fallback: c.fallback,
    action: c.always ? 'Use project, code, test and build tools.' : configured ? 'Use media_generate with the matching type.' : 'Configure FAL_KEY in Settings > Secrets; no paid call is made until a media job is requested.',
  }));
}

function safeMediaUrl(value) {
  let u;
  try { u = new URL(String(value || '')); } catch { throw new Error('Provider lieferte keine gültige Medien-URL.'); }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateV6 = host.includes(':') && (host === '::' || host === '::1' || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith('::ffff:'));
  const privateV4 = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) || host === '0.0.0.0';
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname || /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) || ((isIP(host) === 4 || isIP(host) === 6) && (privateV4 || privateV6))) {
    throw new Error('Medien-URL wurde aus Sicherheitsgründen abgewiesen.');
  }
  return u;
}

function outputUrl(data, type) {
  const item = type === 'image' || type === 'image_edit'
    ? data?.images?.[0] || data?.image
    : data?.[type] || data?.[`${type}_url`] || data?.output;
  return typeof item === 'string' ? item : item?.url;
}

function extension(type, contentType, url) {
  const fromMime = String(contentType || '').toLowerCase().split(';')[0];
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a' };
  if (map[fromMime]) return map[fromMime];
  const ext = extname(new URL(url).pathname).toLowerCase();
  const allowed = type.startsWith('image') ? ['.png', '.jpg', '.jpeg', '.webp'] : type === 'video' ? ['.mp4', '.webm'] : ['.mp3', '.wav', '.ogg', '.m4a'];
  if (allowed.includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  throw new Error(`Provider lieferte ein nicht unterstütztes ${type}-Format (${fromMime || 'unbekannt'}).`);
}

async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error(`Medienausgabe überschreitet das Limit von ${Math.floor(maxBytes / 1048576)} MB.`);
  if (!response.body) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Medienausgabe überschreitet das Limit von ${Math.floor(maxBytes / 1048576)} MB.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function safeName(value, ext, type) {
  const raw = String(value || `villaforge-${type}`).normalize('NFKC').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100) || `villaforge-${type}`;
  const base = raw.replace(/\.(png|jpe?g|webp|mp4|webm|mp3|wav|ogg|m4a)$/i, '');
  return `${base || `villaforge-${type}`}${ext}`;
}

export async function generateMedia({ villaId, type = 'image', prompt, model, sourceImageUrl, filename, fetchImpl = globalThis.fetch }) {
  if (!['image', 'image_edit', 'video', 'audio'].includes(type)) throw new Error('Unbekannter Medientyp.');
  const text = String(prompt || '').trim().slice(0, 4000);
  if (!text) throw new Error('Bitte einen konkreten Prompt angeben.');
  if (type === 'image_edit' && !sourceImageUrl) throw new Error('Für Bildbearbeitung fehlt sourceImageUrl.');
  const key = falKey();
  if (!key) throw new Error(`Medienroute für ${type} ist nicht eingerichtet. FAL_KEY fehlt. Capability-Status mit media_capabilities prüfen; Arbeitsauftrag kann ohne Rendern vorbereitet werden.`);
  const selectedModel = String(model || MODELS[type]);
  if (!/^[a-zA-Z0-9._/-]{3,180}$/.test(selectedModel) || selectedModel.includes('..') || selectedModel.startsWith('/')) throw new Error('Ungültige Modellroute.');
  const input = { prompt: text };
  if (sourceImageUrl) input.image_url = safeMediaUrl(sourceImageUrl).toString();
  const generate = await fetchImpl(`https://fal.run/${selectedModel}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
    body: JSON.stringify(input), signal: AbortSignal.timeout(180000), redirect: 'error',
  });
  if (!generate.ok) throw new Error(`Medienanbieter HTTP ${generate.status}: ${(await generate.text().catch(() => '')).slice(0, 240)}`);
  const data = await generate.json().catch(() => ({}));
  const url = safeMediaUrl(outputUrl(data, type));
  const media = await fetchImpl(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!media.ok) throw new Error(`Download der Medienausgabe HTTP ${media.status}.`);
  const mime = media.headers.get('content-type') || '';
  const actualType = mime.toLowerCase().split(';')[0];
  if (actualType && actualType !== 'application/octet-stream' && !actualType.startsWith(type.startsWith('image') ? 'image/' : `${type}/`)) {
    throw new Error(`Provider lieferte den Medientyp ${actualType}, erwartet wurde ${type}.`);
  }
  const ext = extension(type, mime, url.toString());
  const maxBytes = Math.min(250 * 1024 * 1024, Math.max(1024 * 1024, Number(process.env.VF_MEDIA_MAX_BYTES) || 120 * 1024 * 1024));
  const bytes = await readLimited(media, maxBytes);
  if (!bytes.length) throw new Error('Medienanbieter lieferte eine leere Datei.');
  const dir = join(PROJECT_WORKSPACE, `villa-${Number(villaId)}`);
  mkdirSync(dir, { recursive: true });
  const finalName = safeName(filename, ext, type);
  writeFileSync(join(dir, finalName), bytes);
  return { type, model: selectedModel, path: `villa-${Number(villaId)}/${finalName}`, bytes: bytes.length, mime: mime.split(';')[0] || null };
}
