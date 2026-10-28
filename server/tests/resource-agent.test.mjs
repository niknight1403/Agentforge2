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
