import type { TaskExecutor } from './AgentWorker.js';

export function createHubTaskExecutor({ hubUrl, token, fetcher = fetch }: {
  hubUrl: string;
  token: string;
  fetcher?: typeof fetch;
}): TaskExecutor {
  const base = new URL(hubUrl);
  const host = base.hostname.toLowerCase();
  const privateHost = ['localhost', '127.0.0.1', '::1', 'agentforge', 'host.docker.internal'].includes(host) ||
    host.endsWith('.local') || host.endsWith('.internal') || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!['http:', 'https:'].includes(base.protocol) || (base.protocol === 'http:' && !privateHost) || base.username || base.password || base.search || base.hash || !token || token.length < 32) throw new Error('Invalid Hub executor configuration.');
  const endpoint = `${base.toString().replace(/\/+$/, '')}/internal/mesh/execute`;
  return {
    async execute(input, context) {
      const payload = input as { hubTaskId?: number; villaId?: number };
      if (!Number.isSafeInteger(payload.hubTaskId) || !Number.isSafeInteger(payload.villaId)) throw new Error('Invalid Agentforge task reference.');
      const timeoutMs = Math.max(15_000, Math.min(Number(process.env.AGENTFORGE_TASK_TIMEOUT_MS) || 1_200_000, 1_500_000));
      const response = await fetcher(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ taskId: payload.hubTaskId, villaId: payload.villaId,
          ...(context.promptHint ? { promptHint: context.promptHint.slice(0, 2000) } : {}),
          ...(context.fallbackModel ? { fallbackModel: context.fallbackModel.slice(0, 120) } : {}) }),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
      });
      const body = await response.json().catch(() => ({})) as { status?: string; result?: unknown; error?: string; code?: string };
      if (!response.ok) throw Object.assign(new Error(body.error || `Agentforge returned HTTP ${response.status}`), {
        status: response.status, code: response.status === 503 ? 'LLM_UNAVAILABLE' : 'AGENTFORGE_ERROR'
      });
      if (body.status === 'FAILED') throw Object.assign(new Error('Agentforge task failed.'), { retryable: false, code: body.code || 'HUB_TASK_FAILED' });
      if (body.status !== 'DONE' && body.status !== 'COMPLETED') throw Object.assign(
        new Error(`Agentforge task ended in unexpected state: ${body.status || 'missing status'}`), { retryable: body.status !== 'PENDING' });
      const result = body.result ?? null;
      return { result: result ?? { status: body.status }, steps: [{
        toolName: 'agentforge.execute_task',
        arguments: { hubTaskId: payload.hubTaskId, villaId: payload.villaId },
        result, state: { status: body.status, attempt: context.attempt }
      }] };
    }
  };
}
