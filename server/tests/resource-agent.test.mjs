import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-resource-')), 'test.db');
const { db } = await import('../db.mjs');
const { sampleResources, resourceHistory, resourceStatus, recommendedConcurrency } = await import('../resource-agent.mjs');

test('resource agent samples CPU, RAM, GPU and makes a bounded concurrency recommendation', async () => {
  const sample = await sampleResources({
    clock: () => 123456,
    gpuProbe: async () => ({ available: true, source: 'test', devices: [{ name: 'GPU', utilizationPct: 30, totalBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3 }] })
  });
  assert.equal(sample.sampledAt, 123456);
  assert.ok(sample.cpu.cores >= 1);
  assert.ok(sample.memory.totalBytes > 0);
  assert.equal(sample.gpu.available, true);
  assert.equal(sample.gpu.usedPct, 25);
  assert.ok(sample.recommendation.maxConcurrentTasks >= 1 && sample.recommendation.maxConcurrentTasks <= 8);
  assert.equal(resourceStatus().pressure, sample.pressure);
  assert.equal(resourceHistory(5)[0].sampledAt, 123456);
  assert.ok(recommendedConcurrency() >= 1);
});

test('resource history is bounded and metrics are persisted as non-sensitive telemetry', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM resource_samples').get().count, 1);
  assert.equal(db.prepare('SELECT snapshot FROM resource_samples').get().snapshot.includes('API_KEY'), false);
});

test('Automatic task concurrency counts verified cloud capacity, not configured dead routes',async()=>{
 const {pickConcurrency}=await import('../agents.mjs');
 const old=process.env.VF_LLM_FREE_ONLY;process.env.VF_LLM_FREE_ONLY='0';
 try{
  db.exec('DELETE FROM routes');
  const add=db.prepare('INSERT INTO routes(name,provider,base_url,model,key_env,status,last_used,cooldown_until) VALUES (?,?,?,?,?,?,?,?)');
  add.run('missing-key','groq','https://api.groq.com/openai/v1','test','ABSENT_TEST_KEY','OK',Date.now(),0);
  add.run('cooling','groq','https://api.groq.com/openai/v1','test','','OK',Date.now(),Date.now()+60000);
  add.run('local alternative','lmstudio','http://127.0.0.1:1234/v1','test','','OK',Date.now(),0);
  assert.equal(pickConcurrency(),1);
  db.exec('DELETE FROM routes');assert.equal(pickConcurrency(),1);
  db.prepare("UPDATE routes SET key_env='',cooldown_until=0,status='ERROR'").run();
  assert.equal(pickConcurrency(),1);
 }finally{if(old===undefined)delete process.env.VF_LLM_FREE_ONLY;else process.env.VF_LLM_FREE_ONLY=old;}
});
