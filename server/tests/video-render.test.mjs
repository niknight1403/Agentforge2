import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, existsSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {renderVillaVideo, normalizeManifest, renderManifestPath} from '../video-render.mjs';
import {isPlayableArtifact} from '../media-artifact.mjs';

const ffmpeg = (()=>{try{execFileSync('ffmpeg',['-version'],{stdio:'ignore'});return true;}catch{return false;}})();

test('Manifest wird validiert statt blind uebernommen',()=>{
 assert.throws(()=>normalizeManifest({scenes:[]}), /RENDER_MANIFEST_EMPTY/);
 assert.throws(()=>normalizeManifest({scenes:[{text:'ok',image:'../../etc/passwd'}]}), /RENDER_SCENE_UNSAFE/);
 assert.throws(()=>normalizeManifest({scenes:[{text:'ok'}],audio:'/etc/passwd'}), /RENDER_AUDIO_UNSAFE/);
 const m = normalizeManifest({title:'T',scenes:[{text:'Hallo',seconds:2}],width:9999,height:10});
 assert.equal(m.width,1920);
 assert.equal(m.height,240);
 assert.equal(m.out,'dist/video/villa-show.mp4');
});
test('Manifest wird im Projekt erkannt',()=>{
 const dir = mkdtempSync(join(tmpdir(),'vf-manifest-'));
 assert.equal(renderManifestPath(dir), null);
 writeFileSync(join(dir,'villaforge.render.json'),'{"scenes":[{"text":"x"}]}');
 assert.ok(renderManifestPath(dir));
});
test('echtes MP4 wird gerendert und ist abspielbar', {skip: !ffmpeg && 'ffmpeg fehlt'}, async ()=>{
 const dir = mkdtempSync(join(tmpdir(),'vf-render-test-'));
 const out = await renderVillaVideo(dir, {title:'Test',width:320,height:180,fps:10,scenes:[{text:'Erster Akt',seconds:1},{text:'Zweiter Akt',seconds:1}]});
 assert.ok(existsSync(out.path));
 const bytes = readFileSync(out.path);
 assert.ok(statSync(out.path).size > 2048);
 assert.equal(isPlayableArtifact(bytes,'.mp4'), true);
 assert.equal(out.codec,'libx264');
 assert.equal(out.seconds,2);
});
