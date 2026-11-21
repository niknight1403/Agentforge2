import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {aggregateAuditCheckCounts} from './villa-audit-diagnostics.mjs';

test('aggregates allowlisted check codes and statuses deterministically',()=>{
 const report={villas:[
  {villaId:912,idea:'PRIVATE PROJECT TEXT',checks:[
   {code:'product_acceptance',status:'blocked'},
   {code:'project_brief',status:'pass'},
   {code:'product_acceptance',status:'blocked'}
  ]},
  {villaId:34,checks:[
   {code:'agent_prompts',status:'pass'},
   {code:'development_tools',status:'warning'}
  ]}
 ]};
 const expected=[
  {code:'agent_prompts',status:'pass',count:1},
  {code:'development_tools',status:'warning',count:1},
  {code:'product_acceptance',status:'blocked',count:2},
  {code:'project_brief',status:'pass',count:1}
 ];
 assert.deepEqual(aggregateAuditCheckCounts(report),expected);
 assert.deepEqual(aggregateAuditCheckCounts({villas:[...report.villas].reverse()}),expected);
});

test('maps unknown codes and statuses to one safe bucket without echoing input',()=>{
 const counts=aggregateAuditCheckCounts({villas:[{villaId:34,checks:[
  {code:'private_code=TOKEN_VALUE',status:'blocked'},
  {code:'another_private_code',status:'contains free text'}
 ]}]});
 assert.deepEqual(counts,[{code:'other',status:'blocked',count:1},{code:'other',status:'other',count:1}]);
 assert.doesNotMatch(JSON.stringify(counts),/34|TOKEN_VALUE|private_code|free text/);
});

test('rejects missing and malformed reports explicitly',()=>{
 for(const report of [undefined,null,{}, {villas:{}}, {villas:[{status:'blocked'}]}, {villas:[{checks:[{code:'x'}]}]}]){
  assert.throws(()=>aggregateAuditCheckCounts(report),{code:'AUDIT_REPORT_INVALID'});
 }
});

test('CLI emits only aggregate JSON and fails explicitly for a missing report',()=>{
 const directory=mkdtempSync(join(tmpdir(),'villa-audit-diagnostics-'));
 try{
  const reportPath=join(directory,'report.json');
  const privateText='Villa 912 PRIVATE PROJECT TEXT secret=TOKEN_VALUE';
  writeFileSync(reportPath,JSON.stringify({villas:[{villaId:912,idea:privateText,checks:[
   {code:'product_acceptance',status:'blocked',detail:privateText},
   {code:'project_brief',status:'pass',detail:privateText}
  ]}]}));
  const script=fileURLToPath(new URL('./villa-audit-diagnostics.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,reportPath],{encoding:'utf8'});
  assert.equal(result.status,0);
  assert.equal(result.stdout,'Villa audit check counts: [{"code":"product_acceptance","status":"blocked","count":1},{"code":"project_brief","status":"pass","count":1}]\n');
  assert.doesNotMatch(result.stdout,/912|PRIVATE PROJECT TEXT|TOKEN_VALUE|secret=/);
  const missing=spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8'});
  assert.equal(missing.status,1);
  assert.equal(missing.stderr,'Villa audit diagnostics failed (AUDIT_REPORT_INVALID). No report content was logged.\n');
 }finally{
  rmSync(directory,{recursive:true,force:true});
 }
});
