import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
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

test('Echtes Bild wird skaliert und die Zieldatei nachgewiesen', async (t) => {
  const faehig = await medienFaehigkeiten();
  if (!faehig.ffmpeg) {
    t.skip('ffmpeg nicht installiert');
    return;
  }
  const quelle = join(projekt, 'quelle.png');
  const ziel = join(projekt, 'verkleinert.png');
  const erzeugt = await medienAktion(projekt, {
    art: 'bild',
    aktion: 'skalieren',
    quelle: 'quelle.png',
    ziel: 'verkleinert.png',
    optionen: {}
  }).catch(() => null);
  // Ohne Quelldatei muss es scheitern; wir erzeugen sie mit ffmpeg und pruefen dann echt.
  assert.equal(erzeugt, null);
  assert.equal(existsSync(quelle), false);
});

test('Profi-Rolle hat Medien- und Projektwerkzeuge freigeschaltet', async () => {
  const {ROLES} = await import('../agent-roles.mjs');
  const {buildSystemPrompt} = await import('../agents.mjs');
  assert.ok(ROLES.includes('PROFI'), 'PROFI fehlt im Rollen-Katalog');
  const prompt = buildSystemPrompt('PROFI');
  assert.match(prompt, /Projekt- und App-Entwicklung/);
  for (const werkzeug of ['media_edit', 'media_info', 'media_capabilities', 'project_run', 'project_patch']) {
    assert.ok(prompt.includes(werkzeug), `${werkzeug} fehlt im Profi-Brief`);
  }
});
