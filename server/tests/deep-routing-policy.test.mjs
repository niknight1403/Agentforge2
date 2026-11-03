import test from 'node:test';
import assert from 'node:assert/strict';
import { createCascade } from '../llm-cascade.mjs';

const local={id:1,name:'ollama-local',provider:'ollama',base_url:'http://127.0.0.1:11434/v1',model:'coder',priority:1};
const cloud={id:2,name:'cloud',provider:'groq',base_url:'https://api.groq.com/openai/v1',model:'cloud',priority:1};
const remote={id:3,name:'ollama-remote',provider:'ollama',base_url:'https://model.example.com/v1',model:'coder',priority:1};
function mockCascade(routes){const used=[];const run=createCascade({routes:()=>routes,key:()=>'',freeOnly:()=>false,call:async(r)=>{used.push(r.name);return {content:'ok',route:r.name};}});return {run,used};}
test('offlineOnly cannot reach cloud or remote self-hosted routes',async()=>{
 const {run,used}=mockCascade([cloud,remote,local]);
 await run([{role:'user',content:'test'}],{routeScope:'offlineOnly'});
 assert.deepEqual(used,['ollama-local']);
});
test('offlineOnly fails closed if only cloud is configured',async()=>{
 const {run,used}=mockCascade([cloud]);
 await assert.rejects(run([{role:'user',content:'test'}],{routeScope:'offlineOnly'}),{code:'LLM_UNAVAILABLE'});
 assert.deepEqual(used,[]);
});
test('selfHostedOnly excludes cloud even when it has highest priority',async()=>{
 const {run,used}=mockCascade([cloud,local]);
 await run([{role:'user',content:'test'}],{routeScope:'selfHostedOnly'});
 assert.deepEqual(used,['ollama-local']);
});
