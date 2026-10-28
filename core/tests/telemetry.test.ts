import { describe, it, expect } from 'vitest';
import { AgentTelemetry } from '../src/telemetry/AgentTelemetry.js';

describe('AgentTelemetry', () => {
  it('init im none-Modus ohne SDK (fehlertolerant)', async () => {
    expect(await AgentTelemetry.init('none')).toBe(false);
  });

  it('traceStep reicht Werte durch und markiert Fehler-Spans', async () => {
    const result = await AgentTelemetry.traceStep('villa.run', { villaId: 2 }, async () => 'ergebnis');
    expect(result).toBe('ergebnis');
    await expect(
      AgentTelemetry.traceStep('villa.fail', { villaId: 3 }, async () => { throw new Error('kaputt'); })
    ).rejects.toThrow('kaputt');
  });
});
