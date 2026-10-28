export interface ExecutionStep {
    toolName: string;
    arguments: Record<string, any>;
    result?: any;
    error?: string;
}
export interface SupervisorConfig {
    maxRepetitions: number;
    maxRetries: number;
}
export type AnomalyType = 'INFINITE_LOOP' | 'REPEATED_FAILURE';
export interface Anomaly {
    hasAnomaly: boolean;
    type?: AnomalyType;
    details?: string;
}
export interface Intervention {
    action: 'CONTINUE' | 'MUTATE_PROMPT' | 'FALLBACK_MODEL';
    adjustedPrompt?: string;
    fallbackModel?: string;
    reason?: string;
}
export interface CheckpointSnapshot {
    taskId: string;
    agentId: string;
    stepNumber: number;
    stateSnapshot: Record<string, any>;
    createdAt: number;
}
/**
 * Hierarchischer Supervisor mit Selbstheilung: erkennt Endlosschleifen
 * (identische Tool-Aufrufe) und wiederholte Tool-Fehler, greift mit
 * Prompt-Mutation bzw. Fallback-Modell ein und kann Checkpoints sichern
 * bzw. zurueckspielen.
 */
export declare class HierarchicalSupervisor {
    private config;
    constructor(config?: SupervisorConfig);
    analyzeExecution(history: ExecutionStep[]): Anomaly;
    handleIntervention(agentId: string, anomaly: Anomaly, currentPrompt: string): Intervention;
    /** Sichert den Ausfuehrungszustand als Checkpoint (Prisma: AgentCheckpoint). */
    captureCheckpoint(taskId: string, agentId: string, stepNumber: number, stateSnapshot: Record<string, any>): CheckpointSnapshot;
    /** Baut einen Restore-Prompt aus einem Checkpoint fuer die Selbstheilung. */
    buildRestoredPrompt(checkpoint: CheckpointSnapshot, mission: string): string;
}
