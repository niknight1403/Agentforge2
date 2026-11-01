import {test} from 'node:test';import assert from 'node:assert/strict';import {executeInvocation} from '../project-process.mjs';
const invocation={binary:'docker',args:['run'],cleanup:{binary:'docker',args:['rm','--force','fixture']}};
test('unresponsive attached CLI cannot prevent timeout cleanup and resolution',async()=>{
 const seen=[];let kills=0;
 const out=await new Promise(resolve=>executeInvocation(invocation,{timeout:10},error=>resolve(error),{cleanupTimeoutMs:30,exec:(_,args,opts,cb)=>{
  seen.push(args);if(args[0]==='rm')queueMicrotask(()=>cb(null));return {kill(signal){assert.equal(signal,'SIGKILL');kills++;}};
 }}));
 assert.equal(out.code,'ETIMEDOUT');assert.equal(kills,1);assert.equal(seen.length,2);assert.deepEqual(seen[1],invocation.cleanup.args);
});
test('cleanup failure cannot be returned as successful execution',async()=>{
 const error=await new Promise(resolve=>executeInvocation(invocation,{timeout:1000},resolve,{exec:(_,args,opts,cb)=>{queueMicrotask(()=>cb(args[0]==='rm'?Error('failure'):null));return {kill(){}};}}));
 assert.equal(error.code,'SANDBOX_CLEANUP_FAILED');
});
test('normal completion cleans container before delivering exactly once',async()=>{
 let calls=0;const order=[];
 await new Promise(resolve=>executeInvocation(invocation,{timeout:1000},error=>{calls++;assert.equal(error,null);order.push('done');resolve();},{exec:(_,args,opts,cb)=>{order.push(args[0]);queueMicrotask(()=>cb(null));return {kill(){}};}}));
 assert.deepEqual(order,['run','rm','done']);assert.equal(calls,1);
});
