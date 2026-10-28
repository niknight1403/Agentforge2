import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, TaskStatus } from '@prisma/client';
import { RedisEventBus, type AgentEvent } from './RedisEventBus.js';
import { CheckpointStore } from './CheckpointStore.js';
import { AgentTelemetry } from './AgentTelemetry.js';
import { HierarchicalSupervisor, type ExecutionStep } from './HierarchicalSupervisor.js';

export interface PlannedStep { toolName: string; arguments: Record<string, unknown>; result?: unknown; error?: string; state: unknown }
export interface TaskExecutor { execute(input: Prisma.JsonValue, context: { taskId: string; attempt: number; signal: AbortSignal; promptHint?: string; fallbackModel?: string; recovery?: { checkpointId: string; sequence: number; state: Prisma.JsonValue } }): Promise<{ result: unknown; steps: PlannedStep[] }> }
const SECRET = /api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credential/i;
function assertNoCredentialFields(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error('Task input nesting limit exceeded.');
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) assertNoCredentialFields(item, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) { if (SECRET.test(key)) throw new Error(`Secret field '${key}' must be referenced from the secret store.`); assertNoCredentialFields(item, depth + 1); }
}

export class AgentWorker {
  private readonly checkpoints: CheckpointStore;
  private readonly supervisor = new HierarchicalSupervisor();
  private stopped = false;
  constructor(private readonly prisma: PrismaClient, private readonly bus: RedisEventBus,
    private readonly executor: TaskExecutor, private readonly stream = process.env.VF_AGENT_TASK_STREAM || 'vf:agent-tasks',
    private readonly group = 'agentforge-workers') { this.checkpoints = new CheckpointStore(prisma); }

  async enqueue(title: string, input: Prisma.InputJsonValue, requestKey?: string) {
    assertNoCredentialFields(input);
    try {
      return await this.prisma.$transaction(async tx => {
        const hubRef=input as {hubTaskId?:unknown;villaId?:unknown};
        const task = await tx.agentTask.create({ data: { title: title.slice(0, 500), input,
          ...(requestKey ? { requestKey } : {}),
          ...(Number.isSafeInteger(hubRef.hubTaskId) ? {hubTaskId:hubRef.hubTaskId as number}:{}),
          ...(Number.isSafeInteger(hubRef.villaId) ? {hubVillaId:hubRef.villaId as number}:{}) } });
        const eventId = randomUUID();
        await tx.agentOutbox.create({ data: { id: eventId, stream: this.stream, event: {
          id: eventId, type: 'task.created', agentId: 'scheduler', timestamp: Date.now(), payload: { taskId: task.id }
        } } });
        return task;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10_000 });
    } catch (error) {
      if (requestKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.agentTask.findUnique({ where: { requestKey } });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Publish committed outbox rows; stable event IDs make crash retries idempotent. */
  async flushOutbox(limit = 100) {
    const rows = await this.prisma.agentOutbox.findMany({ where: { publishedAt: null, availableAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: Math.max(1, Math.min(500, limit)) });
    let published = 0;
    for (const row of rows) {
      await this.bus.publish(row.stream, row.event as unknown as AgentEvent);
      await this.prisma.agentOutbox.updateMany({ where: { id: row.id, publishedAt: null }, data: { publishedAt: new Date() } });
      published++;
    }
    return published;
  }

  async run(signal: AbortSignal) {
    await this.recoverStaleTasks();
    await this.bus.ensureConsumerGroup(this.stream, this.group);
    const consumer = `${hostname().replace(/[^a-zA-Z0-9:_-]/g, '-')}:${process.pid}:${randomUUID().slice(0, 8)}`;
    for await (const message of this.bus.consumeStream(this.stream, this.group, consumer, { signal })) {
      if (signal.aborted || this.stopped) break;
      await AgentTelemetry.traceStep('agent.task.process', { 'messaging.system': 'redis', 'messaging.destination': this.stream }, async span => {
        try {
          await this.process(message.event, signal);
          await this.bus.acknowledge(this.stream, this.group, message.id);
        } catch (error) {
          span.recordException(error as Error);
          // A database/network failure keeps the message pending for XAUTOCLAIM.
          console.error('[AgentWorker] message remains pending', { id: message.id, code: (error as Error)?.name });
        }
      });
    }
  }
  stop() { this.stopped = true; }

  async recoverStaleTasks() {
    const cutoff=new Date(Date.now()-Math.max(60_000,Number(process.env.AGENT_TASK_STALE_MS)||1_800_000));
    const stale=await this.prisma.agentTask.findMany({where:{status:TaskStatus.RUNNING,updatedAt:{lt:cutoff}},select:{id:true,attempt:true}});
    for(const task of stale){
      await this.prisma.$transaction(async tx=>{
        const retry=task.attempt<3;const changed=await tx.agentTask.updateMany({where:{id:task.id,status:TaskStatus.RUNNING,updatedAt:{lt:cutoff}},data:{status:retry?TaskStatus.PENDING:TaskStatus.FAILED,result:{error:'Recovered stale task after worker shutdown.'}}});
        if(retry&&changed.count){const id=randomUUID();await tx.agentOutbox.create({data:{id,stream:this.stream,availableAt:new Date(),event:{id,type:'task.created',agentId:'recovery',timestamp:Date.now(),payload:{taskId:task.id}}}});}
      },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5000,timeout:10_000});
    }
  }

  private async process(event: AgentEvent, signal: AbortSignal) {
    if (event.type !== 'task.created') return;
    const taskId = event.payload.taskId;
    if (typeof taskId !== 'string') throw new Error('task.created event requires taskId.');
    const eventId = event.id;
    if (!eventId || eventId.length > 180) throw new Error('task.created event requires a valid event id.');
    const claimed = await this.prisma.$transaction(async tx => {
      const receipt = await tx.agentEventReceipt.createMany({ data: [{ id: eventId, eventType: event.type, taskId }], skipDuplicates: true });
      if (!receipt.count) return null;
      const task = await tx.agentTask.findUnique({ where: { id: taskId } });
      if (!task || task.status !== TaskStatus.PENDING) return null;
      const changed = await tx.agentTask.updateMany({ where: { id: taskId, status: TaskStatus.PENDING }, data: { status: TaskStatus.RUNNING, attempt: { increment: 1 } } });
      if (!changed.count) return null;
      return tx.agentTask.findUnique({ where: { id: taskId } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10_000 });
    if (!claimed) return; // duplicate, already claimed, or already terminal
    try {
      const recovery = await this.checkpoints.recover(taskId, event.agentId);
      let output: Awaited<ReturnType<TaskExecutor['execute']>> | null = null;
      let promptHint: string | undefined;
      let fallbackModel: string | undefined;
      for (let repair = 0; repair < 3; repair++) {
        output = await this.executor.execute(claimed.input, { taskId, attempt: claimed.attempt, signal,
          ...(promptHint ? { promptHint } : {}), ...(fallbackModel ? { fallbackModel } : {}), ...(recovery ? { recovery } : {}) });
        const history: ExecutionStep[] = output.steps.map(step => ({ toolName: step.toolName, arguments: step.arguments,
          ...(step.error ? { error: step.error } : {}), stateHash: createStateHash(step.state) }));
        const anomaly = this.supervisor.analyzeExecution(history);
        if (!anomaly.hasAnomaly) break;
        const decision = this.supervisor.intervene(event.agentId, anomaly, promptHint || 'Complete the task and verify each state change.', process.env.FALLBACK_LLM_MODEL);
        if (decision.action === 'MUTATE_PROMPT') promptHint = decision.adjustedPrompt;
        else if (decision.action === 'FALLBACK_MODEL' && decision.fallbackModel) fallbackModel = decision.fallbackModel;
        else throw Object.assign(new Error(anomaly.details), { code: anomaly.type });
        if (repair === 2) throw Object.assign(new Error(anomaly.details), { code: anomaly.type });
      }
      if (!output) throw new Error('Executor returned no task result.');
      for (let i = 0; i < output.steps.length; i++) {
        const step = output.steps[i]!;
        await this.checkpoints.persistStep({ taskId, agentId: event.agentId, stepNumber: i + 1,
          toolName: step.toolName, arguments: step.arguments, ...(step.result !== undefined ? { result: step.result } : {}),
          ...(step.error !== undefined ? { error: step.error } : {}), state: step.state });
      }
      await this.prisma.agentTask.update({ where: { id: taskId }, data: { status: TaskStatus.COMPLETED,
        result: output.result == null ? Prisma.JsonNull : output.result as Prisma.InputJsonValue } });
    } catch (error) {
      const canRetry = claimed.attempt < 3 && !signal.aborted && (error as {retryable?:boolean})?.retryable !== false;
      await this.prisma.$transaction(async tx => {
        await tx.agentTask.update({ where: { id: taskId }, data: { status: canRetry ? TaskStatus.PENDING : TaskStatus.FAILED,
          result: { error: String(error).slice(0, 1000) } } });
        if (canRetry) {
          const retryId = randomUUID();
          await tx.agentOutbox.create({ data: { id: retryId, stream: this.stream,
            availableAt: new Date(Date.now() + 1000 * 2 ** claimed.attempt), event: {
              id: retryId, type: 'task.created', agentId: event.agentId, timestamp: Date.now(), payload: { taskId }
            } } });
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10_000 });
    }
  }
}

function createStateHash(value: unknown) {
  const stable = (item: unknown): string => JSON.stringify(item, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  return createHash('sha256').update(stable(value)).digest('hex');
}
