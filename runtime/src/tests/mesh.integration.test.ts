import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RedisEventBus } from '../RedisEventBus.js';
import { AgentWorker } from '../AgentWorker.js';

test('PostgreSQL outbox -> Redis consumer -> atomic step/checkpoint pipeline', { skip: process.env.RUN_MESH_INTEGRATION !== '1' }, async () => {
  const prisma = new PrismaClient(); const bus = new RedisEventBus();
  const suffix = randomUUID(); const stream = `vf:test:${suffix}`; const group = `test-${suffix}`;
  const controller = new AbortController();
  const worker = new AgentWorker(prisma, bus, { async execute(input, context) {
    return { result: { done: true }, steps: [{ toolName: 'test.step', arguments: { taskId: context.taskId }, result: { ok: true }, state: { cursor: 1 } }] };
  } }, stream, group);
  let loop: Promise<void> | undefined; let taskId: string | undefined;
  try {
    await prisma.$connect(); await bus.ensureConsumerGroup(stream, group);
    loop = worker.run(controller.signal);
    const task = await worker.enqueue('integration', { operation: 'test' }, `request:${suffix}`); taskId = task.id;
    await worker.flushOutbox();
    const deadline = Date.now() + 10_000;
    let current = await prisma.agentTask.findUnique({ where: { id: task.id } });
    while (current?.status !== 'COMPLETED' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      current = await prisma.agentTask.findUnique({ where: { id: task.id } });
    }
    assert.equal(current?.status, 'COMPLETED');
    assert.equal(await prisma.agentStep.count({ where: { taskId: task.id } }), 1);
    assert.equal(await prisma.agentTelemetry.count({ where: { taskId: task.id, eventType: 'task.completed' } }), 1);
    const checkpoint = await prisma.agentCheckpoint.findFirst({ where: { taskId: task.id } });
    assert.ok(checkpoint?.id);
  } finally {
    worker.stop(); controller.abort();
    await loop?.catch(() => {});
    if (taskId) {
      await prisma.agentEventReceipt.deleteMany({ where: { taskId } });
      await prisma.agentTelemetry.deleteMany({ where: { taskId } });
      await prisma.agentTask.deleteMany({ where: { id: taskId } });
    }
    await Promise.allSettled([bus.disconnect(), prisma.$disconnect()]);
  }
});
