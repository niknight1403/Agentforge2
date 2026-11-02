import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {verifyLiveLlm} from '../../scripts/live-llm-smoke.mjs';
import {VERSION} from '../version.mjs';

async function fixture(options={}) {
 let healthReads=0,received,chatCalls=0;
 const server=http.createServer((req,res)=>{
  let body='';req.on('data',x=>body+=x);req.on('end',()=>{
   res.setHeader('content-type','application/json');let out;
   if(req.url==='/api/auth/login')out={token:'fixture-session'};
   else if(req.url==='/api/health'){healthReads++;out={ok:true,version:options.version||VERSION,llm:{freeOnly:options.freeOnly!==false,lastSuccessfulReplyAt:healthReads===1?1000:options.stale?1000:11000,lastSuccessfulRoute:'Fixture verified route'}};}
   else if(req.url==='/api/master/chat'){
    received=JSON.parse(body);chatCalls++;
    if(options.busyOnce&&chatCalls===1){res.statusCode=409;out={error:'Der Master-Agent bearbeitet gerade eine andere Nachricht.'};}
    else if(options.unavailable){res.statusCode=503;out={code:'LLM_UNAVAILABLE'};}
    else out={ok:true,answer:options.empty?'':'Die Modellverbindung ist geprüft.',steps:options.actions?[{type:'status'}]:[],offline:options.offline===true};
   }else if(req.url==='/api/villas')out=options.villas||[];
   else if(/^\/api\/villas\/\d+\/product$/.test(req.url))out=options.product||{verified:false,blockers:[]};
   else if(/^\/api\/villas\/\d+\/build$/.test(req.url))out={status:options.buildStatus||'none'};
   else{res.statusCode=404;out={};}res.end(JSON.stringify(out));
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{return await verifyLiveLlm({baseUrl:`http://127.0.0.1:${server.address().port}`,email:'fixture@example.test',password:'fixture-only',clock:()=>10000,expectedVersion:VERSION,retryDelaysMs:options.retryDelaysMs??[0],requireProductAcceptance:options.requireProductAcceptance===true});}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}

test('Release gate verifies the deployed version, free-only policy and fresh model evidence over HTTP',async()=>{
 const out=await fixture();assert.equal(out.ok,true);assert.equal(out.version,VERSION);assert.equal(out.route,'Fixture verified route');
});
test('Live release gate rejects failures instead of passing empty, stale or side-effect responses',async()=>{
 for(const options of [{unavailable:true},{empty:true},{actions:true},{offline:true},{stale:true},{version:'0.0.0'},{freeOnly:false}])await assert.rejects(fixture(options));
});
test('Release smoke rejects credentials in URLs and non-loopback plaintext endpoints',async()=>{
 for(const baseUrl of ['https://token:secret@example.com','http://example.com','https://example.com/?key=no'])await assert.rejects(verifyLiveLlm({baseUrl,email:'x',password:'y'}));
});

test('Voruebergehende Sperre des Masters wird wiederholt statt das Gate zu falen',async()=>{
 const out=await fixture({busyOnce:true});
 assert.equal(out.ok,true,'409 der ersten Anfrage darf das Gate nicht rot machen');
});
test('Dauerhafte Sperre scheitert weiterhin',async()=>{
 await assert.rejects(fixture({busyOnce:true,retryDelaysMs:[]}));
});

test('Live smoke preserves safe per-Villa product diagnostics without logging private blocker text',async()=>{
 const error=await fixture({
  requireProductAcceptance:true,
  villas:[{id:34,tasks_done:95,name:'Private customer project'}],
  product:{verified:false,blockers:['owner@example.test API_KEY=never-log','Verification smoke missing']},
  buildStatus:'ready'
 }).then(()=>null,error=>error);
 assert.ok(error instanceof Error);
 assert.match(error.message,/Live LLM smoke product acceptance blocked: PRODUCT_ACCEPTANCE_MISSING:/);
 assert.match(error.message,/"id":34/);
 assert.match(error.message,/"product":"not_verified"/);
 assert.match(error.message,/"build":"ready"/);
 assert.doesNotMatch(error.message,/owner@example\.test|never-log|Private customer project/);
});
