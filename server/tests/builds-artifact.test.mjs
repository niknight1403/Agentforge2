import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findDeliverableArtifact,artifactTypeForExtension,artifactMime} from '../builds.mjs';

test('build artifact search finds content-valid non-media deliverables and ignores invalid files', () => {
 const root = mkdtempSync(join(tmpdir(), 'vf-deliverable-'));
 try {
  const output = join(root, 'deliverables');
  mkdirSync(output, {recursive: true});
  writeFileSync(join(output, 'invalid.pdf'), 'not a real PDF document');
  writeFileSync(join(output, 'report.md'), '# Research report\\n\\nEvidence, findings and recommended next steps.');
  const found = findDeliverableArtifact(root, ['.pdf', '.md']);
  assert.equal(found?.extension, '.md');
  assert.equal(found?.bytes > 16, true);
 } finally { rmSync(root, {recursive: true, force: true}); }
});

test('AAC and TIFF artifacts are classified and served as media', () => {
 assert.equal(artifactTypeForExtension('.aac'), 'media');
 assert.equal(artifactTypeForExtension('.tif'), 'media');
 assert.equal(artifactTypeForExtension('.tiff'), 'media');
 assert.equal(artifactMime('final.aac', 'media'), 'audio/aac');
 assert.equal(artifactMime('final.tiff', 'media'), 'image/tiff');
});
