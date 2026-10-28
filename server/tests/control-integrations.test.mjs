import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'control-integrations-')),'db');
const store=await import('../control-store.mjs');
const {db}=await import('../db.mjs');
test('integrierte professionelle Skills werden beim Start angelegt und injizierbar',()=>{
 const catalog=store.controlCatalog();
 assert.ok(catalog.skills.some(s=>s.id==='professional-delivery'&&s.enabled===1));
 assert.ok(catalog.skills.some(s=>s.id==='compute-routing-orchestrator'&&s.enabled===1));
 assert.match(store.skillInstructions(),/Quoten.*nicht garantiert/i);
 assert.match(store.skillInstructions(),/tatsächliches Artefakt|echte Exportdateien/i);
 assert.throws(()=>store.deleteControlSkill('professional-delivery'),/deaktivieren/);
});
test('eigene Skills koennen gespeichert, deaktiviert und geloescht werden',()=>{
 const saved=store.saveControlSkill({id:'release-review',title:'Release Review',instructions:'Pruefe Versionierung, Release Notes, Build, Tests und Artefakte vor der Freigabe.'});
 assert.equal(saved.enabled,true);
 assert.equal(store.setControlSkillEnabled('release-review',false).enabled,false);
 assert.doesNotMatch(store.skillInstructions(),/Release Review/);
 assert.equal(store.deleteControlSkill('release-review').deleted,true);
});
test('Connectoren speichern nur Secret-Referenzen und validieren HTTPS sicher',()=>{
 const c=store.saveConnector({id:'demo-api',title:'Demo API',endpoint:'https://api.example.com/status',secretEnv:'DEMO_API_TOKEN'});
 assert.equal(c.secret_env,'DEMO_API_TOKEN');
 assert.equal(db.prepare('SELECT secret_env FROM control_connectors WHERE id=?').get('demo-api').secret_env,'DEMO_API_TOKEN');
 for(const endpoint of ['http://api.example.com','https://127.0.0.1/status','https://api.example.com/status?token=secret']) assert.throws(()=>store.validEndpoint(endpoint));
 assert.throws(()=>store.saveConnector({id:'bad-api',title:'Bad API',endpoint:'https://api.example.com',secretEnv:'Bearer abc'}),/Variablenname/);
});
