import test from 'node:test';
import assert from 'node:assert/strict';
import {deepMissionProfile,deepMissionBrief} from '../deep-mission.mjs';
test('Flutter-APK receives build and device validation requirements',()=>{
 const p=deepMissionProfile('Entwickle eine Flutter Android APK fuer mobile Nutzer');
 assert.equal(p.primary,'android');
 assert.ok(p.capabilities.includes('android-build'));
 assert.ok(p.formats.includes('installable-apk'));
 assert.match(deepMissionBrief('Android APK'),/Keine erfundenen/);
});
test('Multimodal task requests distinct verified outputs',()=>{
 const p=deepMissionProfile('Produziere ein Video mit Audio und Bild');
 assert.ok(p.formats.includes('playable-video'));
 assert.ok(p.formats.includes('playable-audio'));
 assert.ok(p.formats.includes('image-file'));
});
test('Live performance requires interactive audio and latency verification',()=>{
 const p=deepMissionProfile('Erstelle ein MIDI DJ Live Performance Studio');
 assert.equal(p.primary,'live-performance');
 assert.ok(p.capabilities.includes('latency-benchmark'));
});
test('Unknown task defaults to independently verifiable software',()=>{
 const p=deepMissionProfile('Erstelle einen Inventarhelfer');
 assert.equal(p.primary,'software');
 assert.ok(p.lifecycle.includes('VERIFY'));
});
