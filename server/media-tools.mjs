/**
 * Medien-Werkzeuge fuer den Profi-Agenten: Bild, Video und Audio.
 *
 * Alles laeuft lokal mit kostenlosen Werkzeugen (ffmpeg/ffprobe, optional
 * ImageMagick). Es gibt keine Cloud-Abhaengigkeit, keine Keys und keine Kosten.
 * Fehlt ein Werkzeug, wird das ehrlich gemeldet statt einen Erfolg vorzutaeuschen.
 */
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname, join, resolve, relative} from 'node:path';

const AUSGABE_MAX = 4 * 1024 * 1024;
const STANDARD_TIMEOUT = 180000;

function lauf(binary, args, timeoutMs = STANDARD_TIMEOUT) {
  return new Promise((fertig) => {
    execFile(binary, args, {timeout: timeoutMs, maxBuffer: AUSGABE_MAX}, (fehler, stdout, stderr) => {
      fertig({
        ok: !fehler,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        fehler: fehler ? String(fehler.message || fehler) : ''
      });
    });
  });
}

/** Welche Werkzeuge sind wirklich vorhanden? Wird vor jeder Aktion geprueft. */
export async function medienFaehigkeiten() {
  const ergebnis = {ffmpeg: false, ffprobe: false, imagemagick: false, versionen: {}};
  const ff = await lauf('ffmpeg', ['-version'], 15000);
  if (ff.ok) {
    ergebnis.ffmpeg = true;
    ergebnis.versionen.ffmpeg = (ff.stdout.split('\n')[0] || '').slice(0, 80);
  }
  const fp = await lauf('ffprobe', ['-version'], 15000);
  if (fp.ok) {
    ergebnis.ffprobe = true;
    ergebnis.versionen.ffprobe = (fp.stdout.split('\n')[0] || '').slice(0, 80);
  }
  const im = await lauf('convert', ['-version'], 15000);
  if (im.ok) {
    ergebnis.imagemagick = true;
    ergebnis.versionen.imagemagick = (im.stdout.split('\n')[0] || '').slice(0, 80);
  }
  return ergebnis;
}

/** Pfade duerfen das Projekt nicht verlassen. */
function imProjekt(root, pfad) {
  const basis = resolve(root);
  const ziel = resolve(basis, String(pfad || ''));
  if (ziel !== basis && !ziel.startsWith(basis + '/')) throw Error(`Pfad ausserhalb des Projekts: ${pfad}`);
  return ziel;
}

function vorbereiten(root, quelle, ziel) {
  const q = imProjekt(root, quelle);
  if (!existsSync(q)) throw Error(`Quelldatei fehlt: ${quelle}`);
  const z = imProjekt(root, ziel);
  mkdirSync(dirname(z), {recursive: true});
  return {quelle: q, ziel: z};
}

function zahl(wert, name, min = 1, max = 100000) {
  const n = Number(wert);
  if (!Number.isFinite(n) || n < min || n > max) throw Error(`${name} muss zwischen ${min} und ${max} liegen`);
  return Math.round(n);
}

function pruefeErgebnis(r, ziel) {
  if (!r.ok) throw Error(`Medienverarbeitung fehlgeschlagen: ${(r.stderr || r.fehler).split('\n').slice(-3).join(' ').slice(0, 400)}`);
  if (!existsSync(ziel)) throw Error('Werkzeug meldete Erfolg, aber die Zieldatei fehlt');
  return {ok: true, datei: ziel, bytes: statSync(ziel).size};
}

/** Metadaten einer Bild-, Video- oder Audiodatei. */
export async function medienInfo(root, {quelle}) {
  const datei = imProjekt(root, quelle);
  if (!existsSync(datei)) throw Error(`Datei fehlt: ${quelle}`);
  const r = await lauf('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', datei]);
  if (!r.ok) throw Error('ffprobe nicht verfuegbar oder Datei unlesbar');
  const daten = JSON.parse(r.stdout || '{}');
  const video = (daten.streams || []).find((s) => s.codec_type === 'video');
  const audio = (daten.streams || []).find((s) => s.codec_type === 'audio');
  return {
    datei: relative(resolve(root), datei),
    bytes: Number(daten.format?.size || 0),
    dauer: Number(daten.format?.duration || 0),
    format: daten.format?.format_name || '',
    breite: video?.width || null,
    hoehe: video?.height || null,
    bildrate: video?.avg_frame_rate || null,
    video_codec: video?.codec_name || null,
    audio_codec: audio?.codec_name || null,
    kanaele: audio?.channels || null,
    abtastrate: audio?.sample_rate || null
  };
}

const AKTIONEN = {
  bild: ['skalieren', 'zuschneiden', 'umwandeln', 'komprimieren', 'drehen', 'vorschaubild'],
  video: ['schneiden', 'skalieren', 'gif', 'einzelbilder', 'ton_entfernen', 'umwandeln', 'zusammenfuegen'],
  audio: ['schneiden', 'umwandeln', 'normalisieren', 'lautstaerke', 'mischen', 'stille_entfernen']
};

export function medienAktionen() {
  return Object.fromEntries(Object.entries(AKTIONEN).map(([art, liste]) => [art, [...liste]]));
}

/**
 * Fuehrt eine Medienaktion aus.
 * art: bild | video | audio, aktion aus AKTIONEN[art].
 */
export async function medienAktion(root, {art, aktion, quelle, ziel, optionen = {}}) {
  const artKey = String(art || '').toLowerCase();
  if (!AKTIONEN[artKey]) throw Error(`Unbekannte Art "${art}". Erlaubt: ${Object.keys(AKTIONEN).join(', ')}`);
  if (!AKTIONEN[artKey].includes(aktion)) {
    throw Error(`Aktion "${aktion}" gibt es fuer ${artKey} nicht. Erlaubt: ${AKTIONEN[artKey].join(', ')}`);
  }
  // Pfade zuerst pruefen: ein Ausbruch aus dem Projekt ist unabhaengig davon
  // ein Fehler, ob ffmpeg installiert ist.
  imProjekt(root, quelle);
  if (ziel) imProjekt(root, ziel);

  const faehig = await medienFaehigkeiten();
  if (!faehig.ffmpeg) throw Error('ffmpeg ist auf diesem Rechner nicht installiert: ' + (await medienBericht()).hinweis);

  // Zusammenfuegen braucht mehrere Quellen und hat kein einzelnes Zielpaar.
  if (artKey === 'video' && aktion === 'zusammenfuegen') {
    const teile = (Array.isArray(optionen.quellen) ? optionen.quellen : []).map((q) => imProjekt(root, q));
    if (teile.length < 2) throw Error('Zusammenfuegen braucht mindestens zwei Quellen');
    for (const t of teile) if (!existsSync(t)) throw Error(`Quelldatei fehlt: ${t}`);
    const z = imProjekt(root, ziel);
    mkdirSync(dirname(z), {recursive: true});
    const liste = join(dirname(z), `.concat-${Date.now()}.txt`);
    const {writeFileSync} = await import('node:fs');
    writeFileSync(liste, teile.map((t) => `file '${t.replace(/'/g, "'\\''")}'`).join('\n'));
    const r = await lauf('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', liste, '-c', 'copy', z]);
    return pruefeErgebnis(r, z);
  }

  if (artKey === 'audio' && aktion === 'mischen') {
    const quellen = (Array.isArray(optionen.quellen) ? optionen.quellen : []).map((q) => imProjekt(root, q));
    if (quellen.length < 2) throw Error('Mischen braucht mindestens zwei Spuren');
    for (const q of quellen) if (!existsSync(q)) throw Error(`Quelldatei fehlt: ${q}`);
    const z = imProjekt(root, ziel);
    mkdirSync(dirname(z), {recursive: true});
    const args = ['-y'];
    for (const q of quellen) args.push('-i', q);
    args.push('-filter_complex', `amix=inputs=${quellen.length}:duration=longest:dropout_transition=2`, z);
    return pruefeErgebnis(await lauf('ffmpeg', args), z);
  }

  const {quelle: q, ziel: z} = vorbereiten(root, quelle, ziel);

  if (artKey === 'bild') {
    if (aktion === 'skalieren') {
      const b = zahl(optionen.breite, 'breite', 1, 8192);
      const h = optionen.hoehe ? zahl(optionen.hoehe, 'hoehe', 1, 8192) : -1;
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-vf', `scale=${b}:${h}`, z]), z);
    }
    if (aktion === 'zuschneiden') {
      const b = zahl(optionen.breite, 'breite');
      const h = zahl(optionen.hoehe, 'hoehe');
      const x = Number(optionen.x || 0);
      const y = Number(optionen.y || 0);
      const filter = optionen.zentriert ? `crop=${b}:${h}:(iw-${b})/2:(ih-${h})/2` : `crop=${b}:${h}:${x}:${y}`;
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-vf', filter, z]), z);
    }
    if (aktion === 'drehen') {
      const grad = Number(optionen.grad);
      const erlaubt = {90: 'transpose=1', 180: 'transpose=1,transpose=1', 270: 'transpose=2'};
      if (!erlaubt[grad]) throw Error('Drehung erlaubt nur 90, 180 oder 270 Grad');
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-vf', erlaubt[grad], z]), z);
    }
    if (aktion === 'komprimieren') {
      const q2 = Math.min(31, Math.max(2, Number(optionen.qualitaet || 6)));
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-q:v', String(q2), z]), z);
    }
    if (aktion === 'umwandeln') return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, z]), z);
    if (aktion === 'vorschaubild') {
      const b = zahl(optionen.breite || 320, 'breite', 16, 2048);
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-vf', `scale=${b}:-1`, z]), z);
    }
  }

  if (artKey === 'video') {
    if (aktion === 'schneiden') {
      const von = Number(optionen.von || 0);
      const args = ['-y'];
      if (von > 0) args.push('-ss', String(von));
      if (optionen.bis) args.push('-to', String(Number(optionen.bis)));
      else if (optionen.dauer) args.push('-t', String(Number(optionen.dauer)));
      args.push('-i', q, '-c', 'copy', z);
      return pruefeErgebnis(await lauf('ffmpeg', args), z);
    }
    if (aktion === 'skalieren') {
      const b = zahl(optionen.breite, 'breite', 16, 7680);
      const h = optionen.hoehe ? zahl(optionen.hoehe, 'hoehe', 16, 4320) : -2;
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-vf', `scale=${b}:${h}`, z]), z);
    }
    if (aktion === 'gif') {
      const fps = Math.min(30, Math.max(1, Number(optionen.fps || 12)));
      const b = zahl(optionen.breite || 480, 'breite', 64, 1920);
      const dauer = optionen.dauer ? ['-t', String(Number(optionen.dauer))] : [];
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', ...dauer, '-i', q, '-vf', `fps=${fps},scale=${b}:-1:flags=lanczos`, z]), z);
    }
    if (aktion === 'einzelbilder') {
      const ordner = imProjekt(root, String(ziel || 'frames'));
      mkdirSync(ordner, {recursive: true});
      const fps = optionen.fps ? String(Number(optionen.fps)) : '1';
      const r = await lauf('ffmpeg', ['-y', '-i', q, '-vf', `fps=${fps}`, join(ordner, 'bild-%04d.jpg')]);
      if (!r.ok) throw Error(`Einzelbilder fehlgeschlagen: ${r.stderr.slice(-300)}`);
      return {ok: true, ordner: relative(resolve(root), ordner)};
    }
    if (aktion === 'ton_entfernen') return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-an', '-c:v', 'copy', z]), z);
    if (aktion === 'umwandeln') return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, z]), z);
  }

  if (artKey === 'audio') {
    if (aktion === 'schneiden') {
      const args = ['-y'];
      if (optionen.von) args.push('-ss', String(Number(optionen.von)));
      if (optionen.bis) args.push('-to', String(Number(optionen.bis)));
      else if (optionen.dauer) args.push('-t', String(Number(optionen.dauer)));
      args.push('-i', q, '-c', 'copy', z);
      return pruefeErgebnis(await lauf('ffmpeg', args), z);
    }
    if (aktion === 'umwandeln') return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, z]), z);
    if (aktion === 'normalisieren') {
      // EBU R128 Lautheit auf -16 LUFS, wie bei Podcasts und Sprachaufnahmen ueblich.
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', z]), z);
    }
    if (aktion === 'lautstaerke') {
      const faktor = Number(optionen.faktor || 1.5);
      if (!Number.isFinite(faktor) || faktor <= 0 || faktor > 20) throw Error('faktor muss zwischen 0 und 20 liegen');
      return pruefeErgebnis(await lauf('ffmpeg', ['-y', '-i', q, '-af', `volume=${faktor}`, z]), z);
    }
    if (aktion === 'stille_entfernen') {
      return pruefeErgebnis(
        await lauf('ffmpeg', ['-y', '-i', q, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB', z]),
        z
      );
    }
  }

  throw Error(`Aktion "${aktion}" ist nicht umgesetzt`);
}

/** Kurzbericht fuer Agenten und API. */
export async function medienBericht() {
  const faehig = await medienFaehigkeiten();
  return {
    ...faehig,
    aktionen: medienAktionen(),
    hinweis: faehig.ffmpeg
      ? 'Bild, Video und Audio koennen lokal bearbeitet werden.'
      : 'ffmpeg fehlt: ohne Installation ist keine Medienbearbeitung moeglich.'

  };
}
