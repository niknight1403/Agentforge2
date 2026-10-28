import test from 'node:test';
import assert from 'node:assert/strict';
import { HierarchicalSupervisor } from '../HierarchicalSupervisor.js';
import { LLMCircuitBreaker, ProviderError, executeCascade } from '../LLMCircuitBreaker.js';
import { validateShell, validateSql } from '../Guardrails.js';
import { createHubTaskExecutor } from '../HubTaskExecutor.js';

test('supervisor stops identical no-delta calls and intervenes with a new strategy', () => {
  const supervisor = new HierarchicalSupervisor();
  const history = Array.from({ length: 3 }, () => ({ toolName: 'code_write', arguments: { path: 'a.ts' }, stateHash: 'same' }));
  const anomaly = supervisor.analyzeExecution(history);
  assert.equal(anomaly.hasAnomaly, true);
  if (anomaly.hasAnomaly) assert.equal(supervisor.intervene('agent-1', anomaly, 'build').action, 'MUTATE_PROMPT');
  assert.equal(supervisor.analyzeExecution(history.map((step, i) => ({ ...step, stateHash: String(i) }))).hasAnomaly, false);
});

test('supervisor counts consecutive failures for the same tool', () => {
  const supervisor = new HierarchicalSupervisor({ maxRepetitions: 3, maxRetries: 3 });
  const result = supervisor.analyzeExecution(Array.from({ length: 3 }, () => ({ toolName: 'test', arguments: {}, error: 'failed' })));
  assert.deepEqual(result, { hasAnomaly: true, type: 'REPEATED_FAILURE', details: 'Tool test failed 3 consecutive times.' });
});

test('guardrails block shell chaining, shells, destructive SQL, and unparameterized mutation', () => {
  assert.equal(validateShell('bash', ['-c', 'rm -rf /']).allowed, false);
  assert.equal(validateShell('node', ['--eval', 'process.exit(0)']).allowed, false);
  assert.equal(validateShell('npm', ['test']).allowed, true);
  assert.equal(validateSql('DROP TABLE tasks', true).allowed, false);
  assert.equal(validateSql('UPDATE tasks SET status = ?', false).allowed, false);
  assert.equal(validateSql('UPDATE tasks SET status = ? WHERE id = ?', true).allowed, false);
  assert.equal(validateShell('python3', ['-c', 'import os; os.system("whoami")']).allowed, false);
});

test('circuit breaker cascades to a healthy provider and enforces a single half-open probe', async () => {
  const failed = new LLMCircuitBreaker({ name: 'first', endpoint: 'https://llm.example/v1/chat', model: 'm' }, 1, 5,
    async () => new Response('', { status: 503 }));
  const healthy = new LLMCircuitBreaker({ name: 'second', endpoint: 'https://llm.example/v1/chat', model: 'm' }, 1, 5,
    async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ready' } }] }), { status: 200 }));
  const result = await executeCascade([failed, healthy], [{ role: 'user', content: 'hello' }]);
  assert.equal(result.provider, 'second');
  assert.deepEqual(result.attempts, [{ provider: 'first', code: 'HTTP_ERROR' }]);
  await assert.rejects(() => failed.execute([{ role: 'user', content: 'x' }]), e => e instanceof ProviderError && e.code === 'CIRCUIT_OPEN');
  await new Promise(resolve => setTimeout(resolve, 10));
  let release!: (response: Response) => void;
  let probeCalls=0;
  const probe = new LLMCircuitBreaker({ name: 'probe', endpoint: 'https://llm.example/v1/chat', model: 'm' }, 1, 5,
    () => { if(probeCalls++===0)return Promise.resolve(new Response('',{status:503})); return new Promise<Response>(resolve => { release = resolve; }); });
  await assert.rejects(() => probe.execute([{ role: 'user', content: 'x' }]), e => e instanceof ProviderError && e.status === 503);
  // Cooldown expiry grants exactly one probe while concurrent requests fail fast.
  await new Promise(resolve => setTimeout(resolve, 10));
  const firstProbe = probe.execute([{ role: 'user', content: 'x' }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  await assert.rejects(() => probe.execute([{ role: 'user', content: 'x' }]), e => e instanceof ProviderError && e.code === 'CIRCUIT_PROBE_BUSY');
  release(new Response(JSON.stringify({ response: 'ok' }), { status: 200 }));
  assert.equal(await firstProbe, 'ok');
});

test('provider rejects insecure remote endpoints and never forwards timeout metadata', async () => {
  assert.throws(() => new LLMCircuitBreaker({ name: 'bad', endpoint: 'http://llm.example/v1', model: 'm' }));
  let sent: Record<string, unknown> | undefined;
  const provider = new LLMCircuitBreaker({ name: 'local', endpoint: 'http://127.0.0.1/v1', model: 'fixed' }, 3, 30_000,
    async (_url, init) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ response: 'ok' }), { status: 200 }); });
  await provider.execute([{ role: 'user', content: 'x' }], { timeoutMs: 1000, model: 'override' });
  assert.equal(sent?.model, 'fixed'); assert.equal('timeoutMs' in (sent || {}), false);
});

test('provider errors have a stable type for fallback telemetry', () => {
  const error = new ProviderError('rate limited', 429, 'RATE_LIMITED');
  assert.equal(error.status, 429); assert.equal(error.code, 'RATE_LIMITED');
});

test('Hub executor forwards supervisor recovery and preserves terminal task failures', async () => {
  let request: RequestInit | undefined;
  const executor = createHubTaskExecutor({ hubUrl: 'http://agentforge:12000/', token: 'x'.repeat(40), fetcher: async (_url, init) => {
    request = init; return Response.json({ status: 'DONE', result: { ok: true } });
  } });
  const output = await executor.execute({ hubTaskId: 12, villaId: 3 }, {
    taskId: 'runtime-task', attempt: 2, signal: new AbortController().signal,
    promptHint: 'Use another verified tool.', fallbackModel: 'deepseek/deepseek-chat'
  });
  assert.deepEqual(JSON.parse(String(request?.body)), {
    taskId: 12, villaId: 3, promptHint: 'Use another verified tool.', fallbackModel: 'deepseek/deepseek-chat'
  });
  assert.equal((output.result as { ok: boolean }).ok, true);
  const failed = createHubTaskExecutor({ hubUrl: 'http://agentforge:12000', token: 'x'.repeat(40), fetcher: async () => Response.json({ status: 'FAILED' }) });
  await assert.rejects(() => failed.execute({ hubTaskId: 12, villaId: 3 }, {
    taskId: 'runtime-task', attempt: 2, signal: new AbortController().signal
  }), error => (error as { retryable?: boolean }).retryable === false);
});
