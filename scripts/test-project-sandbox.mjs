import {prepareProjectStage,collectProjectStage,disposeProjectStage} from '../server/project-stage.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {projectExecution} from '../server/project-execution.mjs';import {executeInvocation} from '../server/project-process.mjs';
const root=mkdtempSync(join(tmpdir(),'vf-sandbox-'));chmodSync(root,0o777);
const image=process.env.VF_SANDBOX_TEST_IMAGE;
async function run(file,timeout){
 const stage=prepareProjectStage(root);
 const invocation=projectExecution(stage.work,'node',[file],{mode:'docker',image});
 const result=await new Promise(resolve=>executeInvocation(invocation,{timeout,maxBuffer:100000},(error,stdout)=>resolve({error,stdout})));
 const name=invocation.args[invocation.args.indexOf('--name')+1];
 let remains=false;try{execFileSync('docker',['inspect',name],{stdio:'ignore'});remains=true;}catch{}
 assert.equal(remains,false,'container must be removed');
 try{if(!result.error)result.artifacts=collectProjectStage(stage);}finally{disposeProjectStage(stage);}
 return result;
}
try{
 mkdirSync(join(root,'src'));
 writeFileSync(join(root,'check.js'),`const fs=require('node:fs'),assert=require('node:assert/strict'),net=require('node:net');
 assert.notEqual(process.getuid(),0);assert.equal(process.env.GITHUB_TOKEN,undefined);
 assert.throws(()=>fs.writeFileSync('/outside','x'));
 assert.throws(()=>fs.readFileSync('/root/.ssh/id_rsa'));
 fs.writeFileSync('/workspace/src/generated.js','generated');fs.appendFileSync(__filename,'\\n// generated');
 fs.mkdirSync('/workspace/dist/build',{recursive:true});fs.writeFileSync('/workspace/dist/build/result.txt','verified');
 const socket=net.connect({host:'1.1.1.1',port:443});socket.setTimeout(3000);
 socket.on('connect',()=>{console.error('unexpected network');process.exit(1)});
 socket.on('timeout',()=>{socket.destroy();console.log('network blocked')});
 socket.on('error',()=>{console.log('network blocked')});`);
 const normal=await run('check.js',15000);assert.equal(normal.error,null);assert.match(normal.stdout,/network blocked/);assert.equal(readFileSync(join(normal.artifacts.directory,'dist/build/result.txt'),'utf8'),'verified');
 writeFileSync(join(root,'hang.js'),"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
 const started=Date.now(),hung=await run('hang.js',500);assert.ok(hung.error);assert.ok(Date.now()-started<15000,'timeout cleanup must be bounded');
 console.log('DOCKER_SANDBOX_VERIFIED: nonroot, read-only host root, project writes, no network, timeout cleanup');
}finally{rmSync(root,{recursive:true,force:true});}
