import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGenerationFailure } from '../generation-recovery.mjs';

test('provider outages remain retryable',()=>{
 const result=classifyGenerationFailure(Object.assign(new Error('provider unavailable'),{code:'LLM_UNAVAILABLE',statusCode:503}),1,5);
 assert.deepEqual(result,{code:'LLM_UNAVAILABLE',retryable:true,terminal:false});
});

test('rate limits and transient network errors remain retryable',()=>{
 assert.equal(classifyGenerationFailure({status:429},2,5).terminal,false);
 assert.equal(classifyGenerationFailure({code:'ECONNRESET'},2,5).retryable,true);
});

test('permanent validation errors are terminal',()=>{
 const result=classifyGenerationFailure({code:'PROMPT_TOO_LONG'},1,5);
 assert.equal(result.retryable,false);
 assert.equal(result.terminal,true);
});

test('transient failures become terminal at the configured retry limit',()=>{
 const result=classifyGenerationFailure({code:'LLM_UNAVAILABLE',statusCode:503},5,5);
 assert.equal(result.retryable,true);
 assert.equal(result.terminal,true);
});
