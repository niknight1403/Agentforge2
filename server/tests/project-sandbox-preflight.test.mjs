import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectSandboxPreflight} from '../project-sandbox-preflight.mjs';

const image='registry.example.test/agentforge/project@sha256:'+'a'.repeat(64);

test('preflight reports a missing production sandbox without running Docker',()=>{
 let inspected=false;
 const result=projectSandboxPreflight({mode:'',image,inspectImage:()=>{inspected=true;}});
 assert.equal(result.code,'PROJECT_SANDBOX_REQUIRED');
 assert.equal(result.ready,false);
 assert.equal(inspected,false);
});

test('preflight rejects non-Docker and unpinned configuration before inspection',()=>{
 let inspected=false;
 const inspectImage=()=>{inspected=true;};
 assert.equal(projectSandboxPreflight({mode:'host',image,inspectImage}).code,'PROJECT_SANDBOX_MODE_INVALID');
 assert.equal(projectSandboxPreflight({mode:'docker',image:'agentforge:latest',inspectImage}).code,'PROJECT_SANDBOX_PINNED_IMAGE_REQUIRED');
 assert.equal(inspected,false);
});

test('preflight reports Docker unavailable without exposing runtime errors',()=>{
 const result=projectSandboxPreflight({mode:'docker',image,inspectImage:()=>({error:new Error('private environment detail')})});
 assert.equal(result.code,'PROJECT_SANDBOX_DOCKER_UNAVAILABLE');
 assert.equal(JSON.stringify(result).includes('private environment detail'),false);
});

test('preflight distinguishes an image missing locally from Docker failure',()=>{
 const result=projectSandboxPreflight({mode:'docker',image,inspectImage:()=>({status:1,stdout:'',stderr:'private image details'})});
 assert.equal(result.code,'PROJECT_SANDBOX_IMAGE_NOT_PRESENT');
 assert.equal(result.checks.dockerAvailable,true);
 assert.equal(JSON.stringify(result).includes('private image details'),false);
});

test('preflight requires exact digest metadata and never reports a mutable or mismatched image ready',()=>{
 const result=projectSandboxPreflight({mode:'docker',image,inspectImage:()=>({status:0,stdout:JSON.stringify(['registry.example.test/agentforge/project@sha256:'+'b'.repeat(64)])})});
 assert.equal(result.code,'PROJECT_SANDBOX_IMAGE_DIGEST_MISMATCH');
 assert.equal(result.ready,false);
});

test('preflight accepts only an already-present matching pinned image',()=>{
 let inspectedReference='';
 const result=projectSandboxPreflight({mode:'docker',image,inspectImage:(reference)=>{inspectedReference=reference;return {status:0,stdout:JSON.stringify([image])};}});
 assert.equal(result.code,'PROJECT_SANDBOX_READY');
 assert.equal(result.ready,true);
 assert.equal(inspectedReference,image);
 assert.deepEqual(result.checks,{modeConfigured:true,imagePinned:true,dockerAvailable:true,imagePresent:true});
});

test('preflight output excludes the configured image reference',()=>{
 const result=projectSandboxPreflight({mode:'docker',image,inspectImage:()=>({status:0,stdout:JSON.stringify([image])})});
 assert.equal(JSON.stringify(result).includes(image),false);
});
