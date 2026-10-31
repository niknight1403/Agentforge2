import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const script=resolve('scripts/villa-mission.sh');
function run(ids=''){
 const dir=mkdtempSync(join(tmpdir(),'mission-')),trace=join(dir,'trace');
 writeFileSync(join(dir,'curl'),`#!/usr/bin/env bash\nurl="\${!#}"\nprintf '%s\\n' "$url" >> "$VF_TEST_TRACE"\ncase "$url" in */auth/login) echo '{"token":"test-only"}' ;; */scheduler) echo '{"slots":6,"active":[],"queue":[],"ranking":[{"id":1,"autonomy":0,"status":"PAUSED","open":3,"failed":2}]}' ;; */health) echo '{"ok":true,"version":"test"}' ;; */orchestrate) echo '{"ok":true,"started":true}' ;; *) exit 1 ;; esac\n`,{mode:0o755});
 const out=spawnSync('bash',[script],{env:{...process.env,PATH:dir+':'+process.env.PATH,VF_TEST_TRACE:trace,VF_ADMIN_EMAIL:'test@example.test',VF_ADMIN_PASSWORD:'test-password',VF_MISSION_IDS:ids,VF_MISSION_NAME:''},encoding:'utf8',timeout:5000});
 return {...out,requests:existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n'):[]};
}
test('Scheduled mission never revives a paused Villa or retries failed work',()=>{
 const out=run();assert.equal(out.status,0,out.stderr);assert.deepEqual(out.requests.map(x=>new URL(x).pathname),['/api/auth/login','/api/scheduler','/api/health']);
});
test('Explicit manual starts target exactly the selected Villas',()=>{
 const out=run('2,31');assert.equal(out.status,0,out.stderr);assert.deepEqual(out.requests.filter(x=>x.endsWith('/orchestrate')).map(x=>new URL(x).pathname),['/api/villas/2/orchestrate','/api/villas/31/orchestrate']);
});
test('Invalid workflow input is rejected before any authenticated action',()=>{
 const out=run("1'; touch /tmp/never-run");assert.equal(out.status,2);assert.equal(out.requests.length,0);
});
