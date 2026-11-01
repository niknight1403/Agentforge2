import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {medienFaehigkeiten, medienAktionen, medienAktion, medienInfo, medienBericht} = await import('../media-tools.mjs');

const basis = mkdtempSync(join(tmpdir(), 'medien-'));
const projekt = join(basis, 'projekt');
mkdirSync(projekt, {recursive: true});

test('Medienbericht nennt die wirklich vorhandenen Werkzeuge', async () => {
  const bericht = await medienBericht();
  for (const feld of ['ffmpeg', 'ffprobe', 'imagemagick']) assert.equal(typeof bericht[feld], 'boolean');
  assert.ok(Object.keys(bericht.aktionen).includes('bild'));
  assert.ok(Object.keys(bericht.aktionen).includes('video'));
  assert.ok(Object.keys(bericht.aktionen).includes('audio'));
  assert.match(bericht.hinweis, bericht.ffmpeg ? /lokal bearbeitet/ : /ffmpeg fehlt/);
});

test('Unbekannte Art oder Aktion wird klar abgelehnt, nicht still ignoriert', async () => {
  await assert.rejects(() => medienAktion(projekt, {art: 'hologramm', aktion: 'bauen', quelle: 'a.png', ziel: 'b.png'}), /Unbekannte Art/);
  await assert.rejects(() => medienAktion(projekt, {art: 'audio', aktion: 'skalieren', quelle: 'a.wav', ziel: 'b.wav'}), /gibt es fuer audio nicht/);
});

test('Pfadausbruch aus dem Projekt wird verhindert', async () => {
  await assert.rejects(
    () => medienAktion(projekt, {art: 'bild', aktion: 'umwandeln', quelle: '../../etc/passwd', ziel: 'out.png'}),
    /ausserhalb des Projekts/
  );
});

test('Fehlende Quelle wird gemeldet statt eines erfundenen Erfolgs', async () => {
  await assert.rejects(
    () => medienAktion(projekt, {art: 'audio', aktion: 'normalisieren', quelle: 'gibtsnicht.wav', ziel: 'out.wav'}),
    /Medienverarbeitung|Quelldatei fehlt|ffmpeg/
  );
});

test('Echtes Bild wird skaliert und die Groesse nachgewiesen', async (t) => {
  const faehig = await medienFaehigkeiten();
  if (!faehig.ffmpeg) { t.skip('ffmpeg nicht installiert'); return; }
  const quelle = join(projekt, 'quelle.png');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240', '-frames:v', '1', quelle], {stdio: 'pipe'});
  assert.ok(existsSync(quelle), 'Testbild wurde nicht erzeugt');
  await medienAktion(projekt, {art: 'bild', aktion: 'skalieren', quelle: 'quelle.png', ziel: 'klein.png', optionen: {breite: 160}});
  assert.ok(existsSync(join(projekt, 'klein.png')), 'Zieldatei fehlt');
  const info = await medienInfo(projekt, {quelle: 'klein.png'});
  assert.equal(info.breite, 160);
});

test('Echtes Audio wird normalisiert und mischen funktioniert', async (t) => {
  const faehig = await medienFaehigkeiten();
  if (!faehig.ffmpeg) { t.skip('ffmpeg nicht installiert'); return; }
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', join(projekt, 'ton.wav')], {stdio: 'pipe'});
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', join(projekt, 'ton2.wav')], {stdio: 'pipe'});
  await medienAktion(projekt, {art: 'audio', aktion: 'normalisieren', quelle: 'ton.wav', ziel: 'laut.wav'});
  const info = await medienInfo(projekt, {quelle: 'laut.wav'});
  assert.ok(info.dauer > 0.5, 'Dauer wurde nicht erkannt');
  assert.equal(info.audio_codec, 'pcm_s16le');
  await medienAktion(projekt, {art: 'audio', aktion: 'mischen', quelle: 'ton.wav', ziel: 'mix.wav', optionen: {quellen: ['ton.wav', 'ton2.wav']}});
  assert.ok(existsSync(join(projekt, 'mix.wav')), 'Mischung fehlt');
});
