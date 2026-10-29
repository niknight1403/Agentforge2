import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditResult,REQUIRED_AUDIT_SCOPES} from '../../scripts/lib/audit-result.mjs';
import {launchChrome} from '../../scripts/lib/cdp.mjs';
test('Incomplete browser inspection never reports success with zero findings',()=>{
 const blocked=auditResult({});assert.equal(blocked.status,'blocked');assert.equal(blocked.exitCode,1);assert.equal(blocked.missingScopes.length,9);
 const results=Object.fromEntries(REQUIRED_AUDIT_SCOPES.map(k=>[k,{findings:{contrast:[]}}]));assert.equal(auditResult(results).status,'passed');
 assert.equal(auditResult(results,{error:Error('Chrome unavailable')}).status,'blocked');results.desktop.findings.contrast.push({id:'bad'});assert.equal(auditResult(results).status,'failed');
});
test('Missing Chrome executable fails in a controlled way instead of unhandled spawn error',async()=>{
 await assert.rejects(launchChrome({chrome:'/not-existing-villaforge-chrome'}),/ENOENT/);
});

test('Chrome startup discovers the actual ephemeral DevTools port from its unique profile',async()=>{
 const {mkdtempSync,writeFileSync,chmodSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(join(tmpdir(),'vf-cdp-fixture-')),binary=join(dir,'chrome-fixture');
 writeFileSync(binary,`#!/usr/bin/env node\nconst fs=require('node:fs'),http=require('node:http');\nconst profile=process.argv.find(x=>x.startsWith('--user-data-dir=')).split('=').slice(1).join('=');\nconst s=http.createServer((q,r)=>r.end(JSON.stringify({Browser:'fixture-only'})));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(profile+'/DevToolsActivePort',String(s.address().port)+'\\n/devtools/browser/fixture'));\nprocess.on('SIGTERM',()=>s.close(()=>process.exit(0)));\n`);chmodSync(binary,0o755);
 let chrome;try{chrome=await launchChrome({chrome:binary});assert.ok(chrome.port>0);assert.equal(chrome.version.Browser,'fixture-only');}finally{chrome?.stop();rmSync(dir,{recursive:true,force:true});}
});
