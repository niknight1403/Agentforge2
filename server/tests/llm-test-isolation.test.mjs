import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const moduleUrl=new URL('../llm-config.mjs',import.meta.url).href;
test('VF_TEST ignores deployment .env files while normal runtime still loads configured provider settings',()=>{
 for(const mode of ['1','0']){
  const dir=mkdtempSync(join(tmpdir(),'env-isolation-'));writeFileSync(join(dir,'.env'),'VF_GROQ_MODEL=fixture-isolation-model\n');
  const env={...process.env,VF_TEST:mode,VF_DB:join(dir,'db')};delete env.VF_GROQ_MODEL;
  const script=`await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify({loaded:process.env.VF_GROQ_MODEL==='fixture-isolation-model'}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,env,encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).loaded,mode==='0');
 }
});
