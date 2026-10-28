import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

const SECRET_KEY = /thought|reasoning|prompt|secret|token|password|credential|authorization|api[_-]?key/i;
function normalize(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (depth > 16) throw new Error('Checkpoint nesting limit exceeded.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value as Prisma.InputJsonValue;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Checkpoint state must be plain JSON.');
  const result: Record<string, Prisma.InputJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    if (SECRET_KEY.test(key)) throw new Error(`Sensitive checkpoint key rejected: ${key}`);
    result[key] = normalize((value as Record<string, unknown>)[key], depth + 1);
  }
  return result as Prisma.InputJsonObject;
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const checkpointHash = (taskId: string, agentId: string, stepNumber: number, parentId: string | null, snapshot: unknown) =>
  createHash('sha256').update([taskId, agentId, String(stepNumber), parentId || '', stable(snapshot)].join('\0')).digest('hex');
const equalHex = (a: string, b: string) => { const aa = Buffer.from(a, 'hex'); const bb = Buffer.from(b, 'hex'); return aa.length === bb.length && timingSafeEqual(aa, bb); };

export interface PersistStepInput {
  taskId: string; agentId: string; stepNumber: number; toolName: string;
  arguments: unknown; result?: unknown; error?: string; state: unknown; sourceId?: string;
}
export class CheckpointStore {
  constructor(private readonly prisma: PrismaClient) {}
  async persistStep(input: PersistStepInput) {
    if (!Number.isInteger(input.stepNumber) || input.stepNumber < 1) throw new Error('stepNumber must be a positive integer.');
    const args = normalize(input.arguments ?? {}) as Prisma.InputJsonValue;
    const snapshot = normalize(input.state);
    if (Buffer.byteLength(stable(snapshot)) > 65_536) throw new Error('Checkpoint snapshot exceeds 64 KiB.');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async tx => {
          if(input.sourceId){
            const duplicate=await tx.agentCheckpoint.findUnique({where:{sourceId:input.sourceId}});
            if(duplicate)return {checkpointId:duplicate.id,sequence:duplicate.stepNumber,parentId:duplicate.parentId,state:duplicate.stateSnapshot};
          }
          const previous = await tx.agentCheckpoint.findFirst({ where: { taskId: input.taskId, agentId: input.agentId }, orderBy: { stepNumber: 'desc' } });
          const stepNumber = previous ? previous.stepNumber + 1 : input.stepNumber;
          const parentId = previous?.id || null;
          const id = checkpointHash(input.taskId, input.agentId, stepNumber, parentId, snapshot);
          const result = input.result === undefined ? Prisma.JsonNull : normalize(input.result);
          await tx.agentStep.create({ data: { taskId: input.taskId, agentId: input.agentId, stepNumber,
            toolName: input.toolName.slice(0, 160), arguments: args, result,
            error: input.error?.slice(0, 4000) || null } });
          const checkpoint = await tx.agentCheckpoint.create({ data: { id, taskId: input.taskId, agentId: input.agentId,
            stepNumber, parentId, stateSnapshot: snapshot, ...(input.sourceId?{sourceId:input.sourceId}:{}) } });
          return { checkpointId: checkpoint.id, sequence: checkpoint.stepNumber, parentId, state: checkpoint.stateSnapshot };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10_000 });
      } catch (error) {
        if (attempt === 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034') throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    throw new Error('Checkpoint transaction retry exhausted.');
  }
  async recover(taskId: string, agentId: string) {
    const rows = await this.prisma.agentCheckpoint.findMany({ where: { taskId, agentId }, orderBy: { stepNumber: 'asc' } });
    let parentId: string | null = null; let latest: typeof rows[number] | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.stepNumber !== i + 1 || row.parentId !== parentId || !equalHex(row.id, checkpointHash(taskId, agentId, row.stepNumber, parentId, row.stateSnapshot))) return null;
      parentId = row.id; latest = row;
    }
    return latest ? { checkpointId: latest.id, sequence: latest.stepNumber, parentId: latest.parentId, state: latest.stateSnapshot } : null;
  }
}
