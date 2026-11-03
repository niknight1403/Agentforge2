import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');

test('production manifest never uses a mutable latest tag',()=>{
  const yaml=readFileSync(resolve(root,'deploy/k8s.yaml'),'utf8');
  assert.ok(!/image:\s*\S+:latest\b/.test(yaml));
  assert.ok(!yaml.includes('\\n'),'manifest contains a literal newline escape');
  const imageLines=yaml.split('\n').filter(line=>/^\s*image:\s*/.test(line));
  assert.equal(imageLines.length,1,'deployment must contain exactly one physical image field');
  assert.match(imageLines[0],/^\s*image:\s*ghcr\.io\/niknight1403\/nexussphere@sha256:[0-9a-f]{64}\s*$/);
});

test('release publishes only a green main CI commit and records immutable digest',()=>{
  const yaml=readFileSync(resolve(root,'../.github/workflows/nexussphere-release.yml'),'utf8');
  assert.ok(yaml.includes("github.event.workflow_run.conclusion == 'success'"));
  assert.ok(yaml.includes("github.event.workflow_run.head_branch == 'main'"));
  assert.ok(yaml.includes('github.event.workflow_run.head_sha'));
  assert.ok(yaml.includes('docker push "$IMAGE:$SHA"'));
  assert.ok(yaml.includes("docker inspect --format='{{index .RepoDigests 0}}'"));
  assert.ok(yaml.includes('docker pull "$DIGEST"'));
});
