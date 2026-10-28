import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RedisEventBus } from './RedisEventBus.js';
import { AgentWorker, type TaskExecutor } from './AgentWorker.js';
import { AgentTelemetry } from './AgentTelemetry.js';
import { CheckpointStore } from './CheckpointStore.js';

const port = Number(process.env.PORT || 12001);
const token = String(process.env.MESH_INTERNAL_TOKEN || '');
const hubUrl = String(process.env.AGENTFORGE_EXECUTOR_URL || '').replace(/\/+$/, '');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
if (token.length < 32) throw new Error('MESH_INTERNAL_TOKEN must contain at least 32 characters.');
if (!hubUrl) throw new Error('AGENTFORGE_EXECUTOR_URL is required.');

const prisma = new PrismaClient();
const bus = new RedisEventBus();
const checkpointStore = new CheckpointStore(prisma);
const executor: TaskExecutor = {
  async execute(input, context) {
    const payload = input as { hubTaskId?: number; villaId?: number };
    if (!Number.isSafeInteger(payload.hubTaskId) || !Number.isSafeInteger(payload.villaId)) throw new Error('Invalid Agentforge task reference.');
    const response = await fetch(`${hubUrl}/internal/mesh/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskId: payload.hubTaskId, villaId: payload.villaId }),
      signal: AbortSignal.timeout(Math.max(15_000, Math.min(Number(process.env.AGENTFORGE_TASK_TIMEOUT_MS) || 1_200_000, 1_500_000)))
    });
    const body = await response.json().catch(() => ({})) as { status?: string; result?: unknown; error?: string };
    if (!response.ok) throw Object.assign(new Error(body.error || `Agentforge returned HTTP ${response.status}`), { status: response.status, code: response.status === 503 ? 'LLM_UNAVAILABLE' : 'AGENTFORGE_ERROR' });
    return { result: body.result ?? { status: body.status || 'completed' }, steps: [{
      toolName: 'agentforge.execute_task', arguments: { hubTaskId: payload.hubTaskId, villaId: payload.villaId },
      result: body.result ?? null, state: { status: body.status || 'completed', attempt: context.attempt }
    }] };
  }
};
const worker = new AgentWorker(prisma, bus, executor);
const controller = new AbortController();
const auth = (req: IncomingMessage) => {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
const send = (res: ServerResponse, status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const item = Buffer.from(chunk); size += item.length; if (size > 64 * 1024) throw Object.assign(new Error('Request body too large.'), { status: 413 }); chunks.push(item); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const [database, redis] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, bus.ping()]);
      const healthy = database.status === 'fulfilled' && redis.status === 'fulfilled';
      return send(res, healthy ? 200 : 503, { ok: healthy, database: database.status, redis: redis.status });
    }
    if (!auth(req)) return send(res, 401, { error: 'Unauthorized' });
    if (req.method === 'POST' && url.pathname === '/tasks') {
      const input = await body(req);
      if (typeof input.title !== 'string' || !input.title.trim() || !input.input || typeof input.input !== 'object') return send(res, 400, { error: 'title and object input are required.' });
      const task = await worker.enqueue(input.title, input.input as never, String(req.headers['idempotency-key'] || '') || undefined);
      return send(res, 202, { id: task.id, status: task.status });
    }
    if(req.method==='POST'&&url.pathname==='/internal/checkpoints'){
      const input=await body(req);
      const hubTaskId=Number(input.hubTaskId),hubVillaId=Number(input.hubVillaId);
      const agentId=String(input.agentId||'');const sourceId=String(input.sourceCheckpointId||'');
      if(!Number.isSafeInteger(hubTaskId)||hubTaskId<1||!Number.isSafeInteger(hubVillaId)||hubVillaId<1||!agentId||agentId.length>160||!/^[a-f0-9]{64}$/i.test(sourceId)||!input.state||typeof input.state!=='object')return send(res,400,{error:'Invalid checkpoint mirror payload.'});
      const task=await prisma.agentTask.findFirst({where:{hubTaskId,hubVillaId},orderBy:{createdAt:'desc'},select:{id:true}});
      if(!task)return send(res,404,{error:'Mesh task is not registered.'});
      const state=input.state as Record<string,unknown>;
      const saved=await checkpointStore.persistStep({taskId:task.id,agentId,stepNumber:Number(state.step)||1,
        toolName:String(state.lastTool||'agent.step').slice(0,160),arguments:{},result:{checkpointSourceId:sourceId},state,sourceId});
      return send(res,201,{checkpointId:saved.checkpointId,sequence:saved.sequence});
    }
    const match = url.pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i);
    if (req.method === 'GET' && match) {
      const task = await prisma.agentTask.findUnique({ where: { id: match[1]! }, select: { id: true, title: true, status: true, attempt: true, result: true, createdAt: true, updatedAt: true } });
      return task ? send(res, 200, task) : send(res, 404, { error: 'Task not found.' });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) { return send(res, Number((error as { status?: number }).status) || 500, { error: String((error as Error).message).slice(0, 300) }); }
});

async function start() {
  await AgentTelemetry.init();
  await prisma.$connect();
  server.listen(port, '0.0.0.0');
  const pump = setInterval(() => { void worker.flushOutbox().catch(error => console.error('[Outbox]', (error as Error).message)); }, 500);
  pump.unref();
  const concurrency=Math.max(1,Math.min(16,Number(process.env.AGENT_WORKER_CONCURRENCY)||3));
  void Promise.all(Array.from({length:concurrency},()=>worker.run(controller.signal)))
    .catch(error => console.error('[AgentWorker]', (error as Error).message));
  console.log(`[agentforge-runtime] listening on ${port}`);
}
async function shutdown() {
  controller.abort(); worker.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.allSettled([bus.disconnect(), prisma.$disconnect(), AgentTelemetry.shutdown()]);
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
start().catch(error => { console.error('[agentforge-runtime] startup failed', error); process.exit(1); });
