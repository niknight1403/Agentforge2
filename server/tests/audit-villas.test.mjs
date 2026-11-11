import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditLiveVillas} from '../../scripts/audit-villas.mjs';

function response(status, value) {
 return new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json'}});
}

test('Villa audit preserves the failed stage and HTTP status without exposing response text', async () => {
 const calls=[];
 const fetchImpl=async (url) => {
  const path=new URL(url).pathname;calls.push(path);
  if(path==='/api/auth/login')return response(200,{token:'test-session'});
  if(path==='/api/health')return response(200,{version:'test'});
  if(path==='/api/villas')return response(200,[{id:34}]);
  if(path==='/api/control/catalog')return response(200,{});
  if(path==='/api/tools')return response(200,[]);
  if(path==='/api/llm/status')return response(200,{routes:[]});
  if(path==='/api/villas/34')return response(200,{villa:{id:34},agents:[],taskCounts:{}});
  if(path==='/api/villas/34/product')return response(503,{message:'PRIVATE_BACKEND_DETAIL_MUST_NOT_LEAK'});
  throw new Error('Unexpected test endpoint: '+path);
 };
 const report=await auditLiveVillas({baseUrl:'https://hub.example',email:'admin@example.test',password:'not-a-real-password',fetchImpl});
 assert.equal(report.complete,false);
 assert.equal(report.summary.unavailable,1);
 assert.deepEqual(report.villas[0].checks[0],{
  code:'audit_fetch_product',status:'blocked',httpStatus:503,
  detail:'Villa-Daten konnten in einer Pruefstufe nicht vollstaendig gelesen werden.',
  nextStep:'Berechtigung, Endpoint und Erreichbarkeit fuer die ausgewiesene Pruefstufe pruefen.'
 });
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE_BACKEND_DETAIL_MUST_NOT_LEAK|not-a-real-password|test-session/);
 assert.ok(calls.includes('/api/villas/34/product'));
});
