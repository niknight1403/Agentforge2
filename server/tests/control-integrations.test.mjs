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

test('Connector DNS policy rejects special-use IPv4 and IPv6 ranges precisely', () => {
  for (const ip of ['192.88.99.1', '198.51.100.10', '203.0.0.8', '203.0.113.5', '2001:0:1::1', '2001:db8::1', '2002:c000:0204::1', '3fff::1', 'fd00::1', 'fe80::1', '::1']) {
    assert.equal(store.publicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '198.51.20.1', '203.0.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(store.publicAddress(ip), true, ip);
  }
});
