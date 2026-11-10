import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safeGeneratedPath, parseGenerationOutput, generationEvent, GENERATION_STREAM } from '../generation-engine.mjs';
import { runGenerationChecks } from '../fs-tools.mjs';

test('generation stream has the documented default',()=>assert.equal(GENERATION_STREAM,'agentforge:events:stream'));
test('rejects traversal, absolute paths and git metadata',()=>{
 for(const path of ['../escape.js','/etc/passwd','C:\\\\Windows\\\\system.ini','.git/config','src/../../escape']) assert.equal(safeGeneratedPath(path),null);
});
test('normalizes safe nested paths',()=>assert.equal(safeGeneratedPath('client/src/App.jsx'),'client/src/App.jsx'));
test('validates bounded JSON generation output',()=>{
 const out=parseGenerationOutput(JSON.stringify({name:'Demo',stack:['node'],files:[{path:'server/index.mjs',content:'export {};'}]}));
 assert.equal(out.files.length,1); assert.deepEqual(out.manifest.files,['server/index.mjs']);
});
test('rejects duplicate paths and oversized file sets',()=>{
 assert.throws(()=>parseGenerationOutput(JSON.stringify({files:[{path:'a.js',content:'a'},{path:'a.js',content:'b'}]})),/GENERATED_PATH/);
 assert.throws(()=>parseGenerationOutput(JSON.stringify({files:[{path:'a.js',content:'x'.repeat(1_500_001)}]})),/GENERATED_OUTPUT_TOO_LARGE/);
});
test('event payloads contain only bounded scalar metadata',()=>{
 const event=generationEvent('PROJECT_PLANNED','task-1',{files:4,prompt:'must not leak',status:'RUNNING'});
 assert.equal(event.files,4); assert.equal(event.prompt,undefined); assert.equal(event.status,'RUNNING');
});

test('generated build execution fails closed without Docker sandbox',async()=>{
 const previous=process.env.VF_PROJECT_SANDBOX;
 delete process.env.VF_PROJECT_SANDBOX;
 try {
  const result=await runGenerationChecks(process.cwd());
  assert.equal(result.ok,false);
  assert.equal(result.error,'GENERATION_DOCKER_SANDBOX_REQUIRED');
 } finally {
  if(previous===undefined) delete process.env.VF_PROJECT_SANDBOX;
  else process.env.VF_PROJECT_SANDBOX=previous;
 }
});

test('offline npm cache copy is executable code, not part of a line comment',()=>{
 const source=readFileSync(new URL('../fs-tools.mjs',import.meta.url),'utf8');
 const copyLine=source.split('\n').find(line=>line.includes('cpSync(sharedCache,jobCache'));
 assert.ok(copyLine,'expected the disposable npm cache copy operation');
 assert.match(copyLine,/^\s*cpSync\(/,'cache copy must start on an executable source line');
});
