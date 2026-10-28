import { createHash } from 'node:crypto';

export interface ExecutionStep { toolName: string; arguments: Record<string, unknown>; result?: unknown; error?: string; stateHash?: string }
export interface SupervisorConfig { maxRepetitions: number; maxRetries: number }
export type Anomaly = { hasAnomaly: false } | { hasAnomaly: true; type: 'INFINITE_LOOP' | 'REPEATED_FAILURE'; details: string };
const stable = (v: unknown): string => JSON.stringify(v, (_k, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');

export class HierarchicalSupervisor {
  constructor(private readonly config: SupervisorConfig = { maxRepetitions: 3, maxRetries: 3 }) {
    if (config.maxRepetitions < 2 || config.maxRetries < 1) throw new Error('Supervisor thresholds are invalid.');
  }
  analyzeExecution(history: ExecutionStep[]): Anomaly {
    const latest = history.at(-1);
    if (!latest) return { hasAnomaly: false };
    const recent = history.slice(-this.config.maxRepetitions);
    if (latest.error && history.slice(-this.config.maxRetries).length === this.config.maxRetries &&
      history.slice(-this.config.maxRetries).every(step => step.toolName === latest.toolName && !!step.error)) {
      return { hasAnomaly: true, type: 'REPEATED_FAILURE', details: `Tool ${latest.toolName} failed ${this.config.maxRetries} consecutive times.` };
    }
    if (recent.length === this.config.maxRepetitions) {
      const latestArgs = hash(latest.arguments);
      const sameNoDelta = recent.every(step => step.toolName === latest.toolName && hash(step.arguments) === latestArgs &&
        step.stateHash === latest.stateHash);
      if (sameNoDelta) return { hasAnomaly: true, type: 'INFINITE_LOOP', details: `Tool ${latest.toolName} repeated without a state change.` };
    }
    return { hasAnomaly: false };
  }
  intervene(agentId: string, anomaly: Anomaly, currentPrompt: string, fallbackModel?: string) {
    if (!anomaly.hasAnomaly) return { action: 'CONTINUE' as const };
    if (anomaly.type === 'INFINITE_LOOP') return {
      action: 'MUTATE_PROMPT' as const,
      adjustedPrompt: `${currentPrompt}\n\n[SELF-HEAL] A repeated tool call made no state change. Choose a different safe strategy and verify the result.`,
      reason: `${agentId}: ${anomaly.details}`
    };
    return { action: 'FALLBACK_MODEL' as const, fallbackModel: fallbackModel || process.env.FALLBACK_LLM_MODEL || null, reason: `${agentId}: ${anomaly.details}` };
  }
}
