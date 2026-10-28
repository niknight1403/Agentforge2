import { describe, it, expect } from 'vitest';
import { LLMCircuitBreaker, BreakerState, TransportFn } from '../src/llm/LLMCircuitBreaker.js';

const config = { name: 'test-provider', endpoint: 'https://llm.local/v1/chat', model: 'test-model', apiKey: 'k' };

describe('LLMCircuitBreaker', () => {
  it('bleibt CLOSED bei Erfolg und extrahiert die Antwort', async () => {
    const ok: TransportFn = async () => ({ data: { choices: [{ message: { content: 'HALLO' } }] } });
    const cb = new LLMCircuitBreaker(config, 3, 30_000, ok);
    expect(await cb.execute('frage')).toBe('HALLO');
    expect(cb.getState()).toBe(BreakerState.CLOSED);
  });

  it('oeffnet nach Fehler-Schwellwert und wirft sofort', async () => {
    let calls = 0;
    const fail: TransportFn = async () => { calls++; throw new Error('boom'); };
    const cb = new LLMCircuitBreaker(config, 3, 30_000, fail);
    for (let i = 0; i < 3; i++) await expect(cb.execute('x')).rejects.toThrow('boom');
    expect(cb.getState()).toBe(BreakerState.OPEN);
    expect(calls).toBe(3);
    // OPEN: keine weiteren Calls
    await expect(cb.execute('x')).rejects.toThrow('Circuit OPEN');
    expect(calls).toBe(3);
  });

  it('oeffnet sofort bei HTTP 429', async () => {
    const rate: TransportFn = async () => {
      const e: any = new Error('429');
      e.response = { status: 429 };
      throw e;
    };
    const cb = new LLMCircuitBreaker(config, 10, 30_000, rate);
    await expect(cb.execute('x')).rejects.toThrow('429');
    expect(cb.getState()).toBe(BreakerState.OPEN);
  });

  it('erlaubt nach Recovery-Zeit genau eine Probe (HALF_OPEN -> CLOSED)', async () => {
    let fail = true;
    const flaky: TransportFn = async () => {
      if (fail) { const e: any = new Error('down'); e.response = { status: 500 }; throw e; }
      return { data: { response: 'WIEDER OK' } };
    };
    const cb = new LLMCircuitBreaker(config, 2, 10, flaky);
    await expect(cb.execute('x')).rejects.toThrow('down');
    await expect(cb.execute('x')).rejects.toThrow('down');
    expect(cb.getState()).toBe(BreakerState.OPEN);
    await new Promise((r) => setTimeout(r, 30));
    fail = false;
    expect(await cb.execute('x')).toBe('WIEDER OK');
    expect(cb.getState()).toBe(BreakerState.CLOSED);
  });
});
