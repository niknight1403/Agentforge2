import type { TaskExecutor } from './AgentWorker.js';

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export function createGenerationTaskExecutor({ hubUrl, token, fetcher = fetch }: {
  hubUrl: string; token: string; fetcher?: typeof fetch;
}): TaskExecutor {
  const base = new URL(hubUrl);
  const host = base.hostname.toLowerCase();
  const privateHost = ['localhost','127.0.0.1','::1','agentforge','host.docker.internal'].includes(host) ||
    host.endsWith('.local') || host.endsWith('.internal') || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!['http:','https:'].includes(base.protocol) || (base.protocol === 'http:' && !privateHost) ||
      base.username || base.password || base.search || base.hash || token.length < 32) throw new Error('Invalid generation executor configuration.');
  const root = base.toString().replace(/\/+$/, '');
  const headers = { 'content-type':'application/json', authorization:`Bearer ${token}` };
  return {
    async execute(input, context) {
      const payload = input as { kind?: unknown; prompt?: unknown; projectId?: unknown };
      if (payload.kind !== 'project.generate' || typeof payload.prompt !== 'string' ||
          !payload.prompt.trim() || payload.prompt.length > 9000) throw new Error('Invalid project generation task input.');
      const taskId = context.taskId;
      const response = await fetcher(root + '/internal/mesh/generate', {
        method:'POST', headers, body:JSON.stringify({ taskId, prompt:payload.prompt, projectId:payload.projectId }),
        signal:AbortSignal.any([context.signal,AbortSignal.timeout(15_000)])
      });
      if (!response.ok) throw Object.assign(new Error('Generation request rejected.'), { code:'GENERATION_REQUEST_REJECTED', retryable:response.status>=500 });
      const deadline = Date.now() + Math.max(30_000,Math.min(Number(process.env.AGENTFORGE_GENERATION_TIMEOUT_MS)||1_200_000,1_500_000));
      while (!context.signal.aborted && Date.now() < deadline) {
        const statusResponse = await fetcher(root + '/internal/mesh/generate/' + encodeURIComponent(taskId), {
          headers:{ authorization:`Bearer ${token}` },
          signal:AbortSignal.any([context.signal,AbortSignal.timeout(10_000)])
        });
        if (statusResponse.ok) {
          const status = await statusResponse.json() as { status?:string; result?:unknown; errorCode?:string };
          if (status.status === 'COMPLETED') return { result:status.result ?? null, steps:[{
            toolName:'agentforge.fullstack.generate', arguments:{ taskId }, result:status.result ?? null,
            state:{ status:'COMPLETED', taskId }
          }] };
          if (status.status === 'FAILED') throw Object.assign(new Error('Full-stack generation failed.'), {
            code:status.errorCode || 'GENERATION_FAILED', retryable:false
          });
        } else if (statusResponse.status !== 404) {
          throw Object.assign(new Error('Generation status unavailable.'), { code:'GENERATION_STATUS_UNAVAILABLE', retryable:true });
        }
        await sleep(1500,context.signal);
      }
      throw Object.assign(new Error('Generation task timed out.'), { code:'GENERATION_TIMEOUT', retryable:true });
    }
  };
}
