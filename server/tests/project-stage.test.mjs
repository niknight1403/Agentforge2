import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,symlinkSync,rmSync,existsSync,statSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {prepareProjectStage,collectProjectStage,disposeProjectStage,validStageArtifacts} from '../project-stage.mjs';
test('isolated copy excludes credentials and preserves source and existing build',()=>{
 const root=mkdtempSync(join(tmpdir(),'vf-stage-test-'));let stage;
 try{writeFileSync(join(root,'index.js'),'source');writeFileSync(join(root,'.env'),'secret');mkdirSync(join(root,'dist'));writeFileSync(join(root,'dist/old'),'keep');
 stage=prepareProjectStage(root);assert.equal(existsSync(join(stage.work,'.env')),false);writeFileSync(join(stage.work,'index.js'),'changed in container');mkdirSync(join(stage.work,'dist'));writeFileSync(join(stage.work,'dist/result'),'real output');
 const out=collectProjectStage(stage);assert.equal(readFileSync(join(out.directory,'dist/result'),'utf8'),'real output');assert.equal(readFileSync(join(root,'index.js'),'utf8'),'source');assert.equal(readFileSync(join(root,'dist/old'),'utf8'),'keep');
 }finally{if(stage)disposeProjectStage(stage);rmSync(root,{recursive:true,force:true});}
});
test('changed source rejects stale outputs and symlinks are rejected',()=>{
 const root=mkdtempSync(join(tmpdir(),'vf-stage-test-'));let stage;
 try{writeFileSync(join(root,'index.js'),'a');stage=prepareProjectStage(root);writeFileSync(join(root,'index.js'),'b');assert.throws(()=>collectProjectStage(stage),/SOURCE_CHANGED/);disposeProjectStage(stage);stage=null;symlinkSync('/etc/passwd',join(root,'link'));assert.throws(()=>prepareProjectStage(root),/UNSAFE_FILE/);}finally{if(stage)disposeProjectStage(stage);rmSync(root,{recursive:true,force:true});}
});

test('nested generated paths are preserved and only temporary source copies are writable',()=>{
 const root=mkdtempSync(join(tmpdir(),'vf-stage-test-'));let stage;
 try{mkdirSync(join(root,'src'));writeFileSync(join(root,'src/main.js'),'code');const mode=statSync(join(root,'src/main.js')).mode;
 stage=prepareProjectStage(root);assert.equal(statSync(join(stage.work,'src/main.js')).mode&0o777,0o666);assert.equal(statSync(join(stage.work,'src')).mode&0o777,0o777);assert.equal(statSync(join(root,'src/main.js')).mode,mode);
 mkdirSync(join(stage.work,'dist/build'),{recursive:true});writeFileSync(join(stage.work,'dist/build/app.js'),'built');
 const out=collectProjectStage(stage);assert.equal(readFileSync(join(out.directory,'dist/build/app.js'),'utf8'),'built');assert.equal(validStageArtifacts(root,out),true);writeFileSync(join(out.directory,'dist/build/app.js'),'tampered');assert.equal(validStageArtifacts(root,out),false);
 }finally{if(stage)disposeProjectStage(stage);rmSync(root,{recursive:true,force:true});}
});
