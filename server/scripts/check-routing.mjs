#!/usr/bin/env node
// Run on the Hub host with its existing VF_DB/service environment. No secret values are printed.
import {syncCascadeRoutes} from '../llm-config.mjs';
import {chat,routingStatus} from '../llm.mjs';
console.log(JSON.stringify({sync:syncCascadeRoutes(),routing:routingStatus()}));
if(process.argv.includes('--probe')){
 try{const r=await chat([{role:'user',content:'Antworte nur mit OK.'}],{maxTokens:12,totalTimeoutMs:120000});console.log(JSON.stringify({probe:'passed',route:r.route,model:r.model,offline:r.offline}));}
 catch(e){console.log(JSON.stringify({probe:'failed',code:e.code,attempts:e.attempts||[]}));process.exitCode=1;}
}
