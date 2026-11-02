import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const gradle=readFileSync(resolve(root,'app/build.gradle.kts'),'utf8');
const workflow=readFileSync(resolve(root,'.github/workflows/build-apk.yml'),'utf8');

test('release APK never falls back to the debug signing key',()=>{
 assert.doesNotMatch(gradle,/signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)/);
 assert.match(gradle,/create\("production"\)/);
 assert.match(gradle,/signingConfig\s*=\s*signingConfigs\.getByName\("production"\)/);
 assert.match(gradle,/Production release signing is not configured/);
 assert.match(gradle,/name == "assembleRelease" \|\| name == "bundleRelease"/);
});

test('release signing requires protected runner values and a temporary keystore',()=>{
 for(const name of ['VILLA_RELEASE_KEYSTORE_BASE64','VILLA_RELEASE_STORE_PASSWORD','VILLA_RELEASE_KEY_ALIAS','VILLA_RELEASE_KEY_PASSWORD']){
  assert.ok(workflow.includes(`secrets.${name}`),`workflow reads ${name} only from GitHub Secrets`);
 }
 assert.match(workflow,/RUNNER_TEMP\/villaforge-release\.keystore/);
 assert.match(workflow,/chmod 600 "\$KEYSTORE_PATH"/);
 assert.ok(workflow.indexOf('name: Produktions-Keystore bereitstellen')<workflow.indexOf('name: Release-APK bauen'));
});

test('production release publishing remains behind the live product acceptance gate',()=>{
 const productGate=workflow.indexOf('name: Produktive LLM-Kette und Villa-Produktabnahme prüfen');
 const publish=workflow.indexOf('name: GitHub-Release mit getesteter APK erstellen');
 assert.ok(productGate>=0&&publish>productGate);
});
