/**
 * Hierarchischer Supervisor mit Selbstheilung: erkennt Endlosschleifen
 * (identische Tool-Aufrufe) und wiederholte Tool-Fehler, greift mit
 * Prompt-Mutation bzw. Fallback-Modell ein und kann Checkpoints sichern
 * bzw. zurueckspielen.
 */
export class HierarchicalSupervisor {
    config;
    constructor(config = { maxRepetitions: 3, maxRetries: 3 }) {
        this.config = config;
    }
    analyzeExecution(history) {
        if (history.length === 0)
            return { hasAnomaly: false };
        const latest = history[history.length - 1];
        if (latest.error) {
            const recentErrors = history.filter((h) => h.toolName === latest.toolName && h.error).length;
            if (recentErrors >= this.config.maxRetries) {
                return {
                    hasAnomaly: true,
                    type: 'REPEATED_FAILURE',
                    details: `Tool '${latest.toolName}' failed ${recentErrors} consecutive times: ${latest.error}`,
                };
            }
        }
        if (history.length >= this.config.maxRepetitions) {
            const recentSteps = history.slice(-this.config.maxRepetitions);
            const isIdenticalLoop = recentSteps.every((step) => step.toolName === latest.toolName &&
                JSON.stringify(step.arguments) === JSON.stringify(latest.arguments));
            if (isIdenticalLoop) {
                return {
                    hasAnomaly: true,
                    type: 'INFINITE_LOOP',
                    details: `Infinite loop: Tool '${latest.toolName}' invoked ${this.config.maxRepetitions}x with identical arguments.`,
                };
            }
        }
        return { hasAnomaly: false };
    }
    handleIntervention(agentId, anomaly, currentPrompt) {
        if (!anomaly.hasAnomaly)
            return { action: 'CONTINUE' };
        console.warn(`[Supervisor] Self-Healing triggered for Agent [${agentId}]:`, anomaly.details);
        if (anomaly.type === 'INFINITE_LOOP') {
            return {
                action: 'MUTATE_PROMPT',
                adjustedPrompt: `${currentPrompt}\n\n[SYSTEM OVERRIDE / SELF-HEALING]: Loop detected. Switch immediately to an alternative tool or strategy.`,
                reason: anomaly.details,
            };
        }
        return {
            action: 'FALLBACK_MODEL',
            fallbackModel: process.env.FALLBACK_LLM_MODEL || 'deepseek/deepseek-chat',
            reason: anomaly.details,
        };
    }
    /** Sichert den Ausfuehrungszustand als Checkpoint (Prisma: AgentCheckpoint). */
    captureCheckpoint(taskId, agentId, stepNumber, stateSnapshot) {
        return {
            taskId,
            agentId,
            stepNumber,
            stateSnapshot,
            createdAt: Date.now(),
        };
    }
    /** Baut einen Restore-Prompt aus einem Checkpoint fuer die Selbstheilung. */
    buildRestoredPrompt(checkpoint, mission) {
        const snapshotSummary = Object.entries(checkpoint.stateSnapshot)
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
            .join('; ');
        return `${mission}\n\n[SYSTEM RESTORE / SELF-HEALING]: Zeitreise auf Checkpoint nach Schritt ${checkpoint.stepNumber} (Agent ${checkpoint.agentId}). Gesicherter Zustand: ${snapshotSummary}. Fahre von hier aus mit einer ANDEREN Strategie fort.`;
    }
}
//# sourceMappingURL=HierarchicalSupervisor.js.map