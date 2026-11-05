import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isPlayableArtifact, findMediaArtifact, listMediaFiles, isMediaExtension} from '../media-artifact.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'vf-media-'));

test('umbenannter Text ist kein Video',()=>{
 const buf = Buffer.alloc(4096, 0x61);
 assert.equal(isPlayableArtifact(buf, '.mp4'), false);
 assert.equal(isPlayableArtifact(buf, '.mp3'), false);
});
test('zu kleine Dateien gelten nicht als Produkt',()=>{
 const tiny = Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypisom','latin1')]);
 assert.equal(isPlayableArtifact(tiny, '.mp4'), false);
});
test('echte Container werden erkannt',()=>{
 const mp4 = Buffer.concat([Buffer.from([0,0,0,0x18]), Buffer.from('ftypisom','latin1'), Buffer.alloc(2048)]);
 assert.equal(isPlayableArtifact(mp4, '.mp4'), true);
 const wav = Buffer.concat([Buffer.from('RIFF','latin1'), Buffer.from([0,0,0,0]), Buffer.from('WAVE','latin1'), Buffer.alloc(2048)]);
 assert.equal(isPlayableArtifact(wav, '.wav'), true);
 const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47]), Buffer.alloc(2048)]);
 assert.equal(isPlayableArtifact(png, '.png'), true);
});
test('findMediaArtifact ignoriert Attrappen und liefert die echte Datei',()=>{
 const dir = temp();
 writeFileSync(join(dir, 'platzhalter.mp4'), 'kein video, nur text');
 const real = Buffer.concat([Buffer.from([0,0,0,0x18]), Buffer.from('ftypisom','latin1'), Buffer.alloc(3000)]);
 mkdirSync(join(dir, 'dist','video'), {recursive:true});
 writeFileSync(join(dir, 'dist','video','show.mp4'), real);
 const hit = findMediaArtifact(dir, ['.mp4','.webm']);
 assert.ok(hit, 'echtes Video muss gefunden werden');
 assert.equal(hit.extension, '.mp4');
 assert.ok(hit.path.endsWith('show.mp4'));
});
test('ohne echtes Medien-Artefakt gibt es kein Ergebnis',()=>{
 const dir = temp();
 writeFileSync(join(dir, 'leer.mp4'), Buffer.alloc(64));
 assert.equal(findMediaArtifact(dir, ['.mp4']), null);
 assert.equal(isMediaExtension('.mp4'), true);
 assert.equal(isMediaExtension('.zip'), false);
});
