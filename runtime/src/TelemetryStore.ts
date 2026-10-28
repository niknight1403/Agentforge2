import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const ALLOWED = new Set(['status', 'attempt', 'durationMs', 'provider', 'route', 'errorCode', 'stepCount']);

export function sanitizeTelemetryMetadata(input: Record<string, unknown>) {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value === 'string') safe[key] = value.slice(0, 120);
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = Math.max(0, Math.trunc(value));
    else if (typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

export class TelemetryStore {
  constructor(private readonly prisma: PrismaClient, private readonly retentionDays = 30) {}
  async record(eventType: string, taskId: string, agentId: string, metadata: Record<string, unknown>) {
    if (!/^[a-z][a-z0-9_.-]{1,99}$/.test(eventType) || !taskId || taskId.length > 180 || !agentId || agentId.length > 160) return false;
    await this.prisma.agentTelemetry.create({ data: {
      id: randomUUID(), eventType, taskId, agentId,
      occurredAt: new Date(), metadata: sanitizeTelemetryMetadata(metadata)
    } });
    return true;
  }
  async prune(now = Date.now()) {
    const days = Math.max(1, Math.min(365, this.retentionDays));
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
    return (await this.prisma.agentTelemetry.deleteMany({ where: { occurredAt: { lt: cutoff } } })).count;
  }
}
