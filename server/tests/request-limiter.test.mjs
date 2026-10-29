import {test} from 'node:test';import assert from 'node:assert/strict';
import {createRequestLimiter} from '../request-limiter.mjs';
test('Background cannot consume the last interactive request; total provider quota is unchanged',()=>{
 let time=1000;const limiter=createRequestLimiter({clock:()=>time});
 for(let i=0;i<7;i++)assert.equal(limiter.admit('credential-a',8).ok,true);
 assert.equal(limiter.admit('credential-a',8).ok,false);
 assert.equal(limiter.admit('credential-a',8,{interactive:true}).ok,true);
 assert.equal(limiter.admit('credential-a',8,{interactive:true}).ok,false);
 assert.equal(limiter.admit('credential-b',8).ok,true);
 time+=60000;assert.equal(limiter.admit('credential-a',8).ok,true);assert.equal(limiter.size(),1);
});
test('One-request quotas still allow background progress and never become infinite',()=>{
 const limiter=createRequestLimiter();assert.equal(limiter.admit('tiny',1).ok,true);assert.equal(limiter.admit('tiny',1,{interactive:true}).ok,false);assert.equal(limiter.admit('invalid',Infinity).ok,true);assert.equal(limiter.admit('invalid',Infinity).ok,false);
});
