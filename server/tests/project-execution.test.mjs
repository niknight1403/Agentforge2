import {test} from 'node:test';import assert from 'node:assert/strict';import {tmpdir} from 'node:os';import {realpathSync} from 'node:fs';import {projectExecution} from '../project-execution.mjs';
const image='node@sha256:'+'a'.repeat(64);
test('sandbox binds only workspace and excludes network, host env and privileges',()=>{
 const out=projectExecution(tmpdir(),'node',['test.js'],{mode:'docker',image});
 for(const flag of ['--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges'])assert.ok(out.args.includes(flag));
 assert.equal(out.binary,'docker');assert.match(out.args.find(x=>x.startsWith('--user=')),/^--user=[1-9][0-9]*:[1-9][0-9]*$/);assert.deepEqual(out.cleanup.args,['rm','--force',out.args[out.args.indexOf('--name')+1]]);assert.ok(out.args.includes('type=bind,source='+realpathSync(tmpdir())+',target=/workspace'));assert.deepEqual(out.args.slice(-3),[image,'node','test.js']);
 assert.ok(!out.args.some(x=>/docker.sock|privileged|GITHUB_TOKEN|--env-file/.test(x)));
});
test('invalid or unpinned sandbox configurations fail instead of running on host',()=>{
 assert.throws(()=>projectExecution(tmpdir(),'node',[],{mode:'docker',image:'node:latest'}),/PINNED_IMAGE/);
 assert.throws(()=>projectExecution('/','node',[],{mode:'docker',image}),/WORKSPACE/);
 assert.throws(()=>projectExecution(tmpdir(),'node',[],{mode:'unknown'}),/MODE_INVALID/);
});
test('legacy host mode remains explicit until sandbox deployment is verified',()=>assert.deepEqual(projectExecution('/unused','node',['x'],{mode:'host'}),{binary:'node',args:['x']}));
