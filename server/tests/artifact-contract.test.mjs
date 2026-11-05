import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactContract} from '../artifact-contract.mjs';

test('APK requirement cannot be satisfied by a source ZIP even with passing tests',()=>{
 const r=artifactContract({idea:'Entwickle eine Android App mit lokalem Speicher',kind:'android',artifactType:'zip',artifactName:'villa-7.zip'});
 assert.equal(r.ok,false);
 assert.ok(r.blockers.includes('REQUIRED_ARTIFACT_MISSING:installable-apk'));
});
test('real APK satisfies the format contract, pending independent runtime checks',()=>{
 const r=artifactContract({idea:'Entwickle eine Android App',kind:'android',artifactType:'apk',artifactName:'villa-7.apk'});
 assert.equal(r.ok,true);
});
test('Android source always demands APK, even without modality keywords',()=>{
 const r=artifactContract({idea:'Inventory utility',kind:'android-cloud',artifactType:'tar.gz',artifactName:'source.tar.gz'});
 assert.equal(r.ok,false);
});
test('video and audio require playable output rather than source archive',()=>{
 const r=artifactContract({idea:'Erstelle Video mit Audio',kind:'generic',artifactType:'zip',artifactName:'render.zip'});
 assert.equal(r.ok,false);
 assert.ok(r.blockers.includes('REQUIRED_ARTIFACT_MISSING:playable-video'));
 assert.ok(r.blockers.includes('REQUIRED_ARTIFACT_MISSING:playable-audio'));
});
test('standalone web projects may use verified archives',()=>{
 const r=artifactContract({idea:'Entwickle eine Web-App',kind:'node',artifactType:'zip',artifactName:'villa.zip'});
 assert.equal(r.ok,true);
});
test('image output requires a real image file',()=>{
 const r=artifactContract({idea:'Erstelle Bild',kind:'generic',artifactType:'zip',artifactName:'source.zip'});
 assert.equal(r.ok,false);
});

test('Software-Auftrag mit Medien-Woertern verlangt keine Mediendatei (Villa-10-Fall)',()=>{
 // Idee nennt Audio und Video, das Produkt ist aber eine Controller-Software.
 const r=artifactContract({
  idea:'Ableton Push Controller Software: Audio-Optimierung, MIDI-Latenz, Video-Tutorials',
  kind:'node',artifactType:'zip',artifactName:'villa-10.zip',deliverable:'software'
 });
 assert.equal(r.ok,true);
 assert.deepEqual(r.blockers,[]);
});
test('Software-Auftrag auf Android liefert weiterhin eine APK statt ZIP',()=>{
 const r=artifactContract({
  idea:'Android Controller-App mit Audio-Optimierung',
  kind:'android',artifactType:'zip',artifactName:'villa-10.zip',deliverable:'software'
 });
 assert.equal(r.ok,false);
 assert.deepEqual(r.blockers,['REQUIRED_ARTIFACT_MISSING:installable-apk']);
});
test('Medien-Auftrag bleibt Lieferzwang auch ohne Lieferklasse',()=>{
 const r=artifactContract({idea:'Erstelle Video mit Audio',kind:'generic',artifactType:'zip',artifactName:'render.zip'});
 assert.equal(r.ok,false);
 assert.ok(r.blockers.includes('REQUIRED_ARTIFACT_MISSING:playable-video'));
});
test('classifyDeliverable erkennt Software trotz Audio-/Video-Woertern',async()=>{
 const {classifyDeliverable}=await import('../delivery-quality.mjs');
 assert.equal(classifyDeliverable('Ableton Push Controller Software: Audio-Optimierung, Video-Tutorials'),'software');
 assert.equal(classifyDeliverable('Erstelle ein Video ueber mein Produkt'),'video');
});
