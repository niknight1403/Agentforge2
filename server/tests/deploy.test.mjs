import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
// Pfadrobust: Der Test muss vom Repo-Root aus funktionieren, egal aus welchem
// Verzeichnis node --test gestartet wird (VM-Deploy laeuft aus server/).
const ROOT=resolve(import.meta.dirname,'../..');
const script=join(ROOT,'deploy.sh');
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'vf-deploy-'));copyFileSync(join(ROOT,'.env.example'),join(dir,'.env.example'));try{fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function run(dir,code){return spawnSync('bash',['-c','source "$1"; cd "$2"; '+code,'deploy-test',script,dir],{encoding:'utf8',env:{PATH:process.env.PATH}});}
const values=dir=>Object.fromEntries(readFileSync(join(dir,'.env'),'utf8').split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
test('Deployment provisioning preserves credentials, is private and never executes dotenv text',()=>fixture(dir=>{
 let r=run(dir,'provision_env');assert.equal(r.status,0,r.stderr);const first=values(dir);
 for(const k of ['VF_ADMIN_PASSWORD','POSTGRES_PASSWORD','REDIS_PASSWORD','WEBHOOK_INTERNAL_TOKEN'])assert.match(first[k],/^[a-f0-9]{64}$/);
 assert.equal(statSync(join(dir,'.env')).mode&0o777,0o600);
 assert.ok(first.REDIS_URL.includes(first.REDIS_PASSWORD));assert.ok(first.DATABASE_URL.includes(first.POSTGRES_PASSWORD));
 writeFileSync(join(dir,'.env'),readFileSync(join(dir,'.env'),'utf8')+'\nUNTRUSTED=$(touch injected)\n');
 r=run(dir,'provision_env');assert.equal(r.status,0,r.stderr);assert.deepEqual(values(dir),{...first,UNTRUSTED:'$(touch injected)'});
 assert.throws(()=>statSync(join(dir,'injected')));
}));
test('Old env files gain missing settings without resetting database passwords',()=>fixture(dir=>{
 writeFileSync(join(dir,'.env'),"POSTGRES_PASSWORD='a+b/c'\nVF_ADMIN_PASSWORD=\"\"\n");
 const r=run(dir,'provision_env');assert.equal(r.status,0,r.stderr);const v=values(dir);assert.equal(v.POSTGRES_PASSWORD,"'a+b/c'");assert.ok(v.DATABASE_URL.includes('a%2Bb%2Fc'));assert.equal(v.HTTP_PORT,'80');assert.match(v.VF_ADMIN_PASSWORD,/^[a-f0-9]{64}$/);
}));
test('Ambiguous env duplicates fail without changing the original file',()=>fixture(dir=>{
 const input='REDIS_PASSWORD=a\nREDIS_PASSWORD=b\n';writeFileSync(join(dir,'.env'),input);
 const r=run(dir,'provision_env');assert.notEqual(r.status,0);assert.equal(readFileSync(join(dir,'.env'),'utf8'),input);
}));
test('OOM repair changes populated settings once; unknown errors do not claim repair',()=>fixture(dir=>{
 const r=run(dir,`provision_env; compose(){ echo fixture-id; }; docker_fixture(){ echo true; }; DOCKER=(docker_fixture); heal_service hub 'Container OOM'; [[ $(env_value NODE_OPTIONS) == --max-old-space-size=256 ]]; if heal_service hub 'Heap out of memory'; then exit 8; fi; if heal_service postgres 'password authentication failed'; then exit 9; fi`);
 assert.equal(r.status,0,r.stderr);
}));
