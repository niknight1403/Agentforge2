import { describe, it, expect } from 'vitest';
import { HierarchicalSupervisor, ExecutionStep } from '../src/supervisor/HierarchicalSupervisor.js';

const step = (toolName: string, args: Record<string, any>, error?: string): ExecutionStep => ({
  toolName, arguments: args, error,
});

describe('HierarchicalSupervisor', () => {
  it('erkennt wiederholte Tool-Fehler (REPEATED_FAILURE) ab Schwellwert', () => {
    const s = new HierarchicalSupervisor({ maxRepetitions: 3, maxRetries: 3 });
    const history = [
      step('project_patch', { file: 'a.ts' }, 'exit 1'),
      step('project_patch', { file: 'b.ts' }, 'exit 1'),
      step('project_patch', { file: 'c.ts' }, 'exit 2'),
    ];
    const anomaly = s.analyzeExecution(history);
    expect(anomaly.hasAnomaly).toBe(true);
    expect(anomaly.type).toBe('REPEATED_FAILURE');
    expect(anomaly.details).toContain('project_patch');
  });

  it('erkennt identische Aufrufe als INFINITE_LOOP', () => {
    const s = new HierarchicalSupervisor({ maxRepetitions: 3, maxRetries: 3 });
    const args = { query: 'selbe frage' };
    const anomaly = s.analyzeExecution([
      step('project_run', args),
      step('project_run', args),
      step('project_run', args),
    ]);
    expect(anomaly.hasAnomaly).toBe(true);
    expect(anomaly.type).toBe('INFINITE_LOOP');
  });

  it('unterscheidet identische Werkzeuge mit unterschiedlichen Argumenten', () => {
    const s = new HierarchicalSupervisor({ maxRepetitions: 3, maxRetries: 3 });
    const anomaly = s.analyzeExecution([
      step('project_run', { query: 'a' }),
      step('project_run', { query: 'b' }),
      step('project_run', { query: 'c' }),
    ]);
    expect(anomaly.hasAnomaly).toBe(false);
  });

  it('liefert CONTINUE ohne Anomalie und leere Historie', () => {
    const s = new HierarchicalSupervisor();
    expect(s.analyzeExecution([])).toEqual({ hasAnomaly: false });
    expect(s.handleIntervention('agent-1', s.analyzeExecution([]), 'prompt').action).toBe('CONTINUE');
  });

  it('mutiert den Prompt bei Loop und schaltet bei Fehlern das Fallback-Modell', () => {
    const s = new HierarchicalSupervisor();
    const loopAnomaly = s.analyzeExecution([
      step('t', { x: 1 }), step('t', { x: 1 }), step('t', { x: 1 }),
    ]);
    const intervention = s.handleIntervention('agent-2', loopAnomaly, 'MISSION');
    expect(intervention.action).toBe('MUTATE_PROMPT');
    expect(intervention.adjustedPrompt).toContain('SYSTEM OVERRIDE / SELF-HEALING');
    expect(intervention.adjustedPrompt).toContain('MISSION');

    const failAnomaly = s.analyzeExecution([
      step('t', { x: 1 }, 'err'), step('t', { x: 2 }, 'err'), step('t', { x: 3 }, 'err'),
    ]);
    const fallback = s.handleIntervention('agent-2', failAnomaly, 'MISSION');
    expect(fallback.action).toBe('FALLBACK_MODEL');
    expect(fallback.fallbackModel).toBe(process.env.FALLBACK_LLM_MODEL || 'deepseek/deepseek-chat');
  });

  it('sichert Checkpoints und baut Restore-Prompts mit Zustandssnapshot', () => {
    const s = new HierarchicalSupervisor();
    const cp = s.captureCheckpoint('task-1', 'agent-5', 7, { lastFile: 'index.ts', openTasks: 3 });
    expect(cp.taskId).toBe('task-1');
    expect(cp.stepNumber).toBe(7);
    const restored = s.buildRestoredPrompt(cp, 'MISSION');
    expect(restored).toContain('SYSTEM RESTORE / SELF-HEALING');
    expect(restored).toContain('lastFile=index.ts');
    expect(restored).toContain('MISSION');
  });
});
