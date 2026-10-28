import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RedisEventBus } from './RedisEventBus.js';
import { AgentWorker } from './AgentWorker.js';
import { AgentTelemetry } from './AgentTelemetry.js';
import { CheckpointStore } from './CheckpointStore.js';
import { createHubTaskExecutor } from './HubTaskExecutor.js';
import { TelemetryStore } from './TelemetryStore.js';

const port = Number(process.env.PORT || 12001);
const token = String(process.env.MESH_INTERNAL_TOKEN || '');
const hubUrl = String(process.env.AGENTFORGE_EXECUTOR_URL || '').replace(/\/+$/, '');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
if (token.length < 32) throw new Error('MESH_INTERNAL_TOKEN must contain at least 32 characters.');
if (!hubUrl) throw new Error('AGENTFORGE_EXECUTOR_URL is required.');

const prisma = new PrismaClient();
const bus = new RedisEventBus();
const checkpointStore = new CheckpointStore(prisma);
const telemetryStore = new TelemetryStore(prisma);
const executor = createHubTaskExecutor({hubUrl,token});
const worker = new AgentWorker(prisma, bus, executor);
const controller = new AbortController();
let outboxTimer: NodeJS.Timeout | undefined;
let recoveryTimer: NodeJS.Timeout | undefined;
let telemetryRetentionTimer: NodeJS.Timeout | undefined;
const auth = (req: IncomingMessage) => {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
const send = (res: ServerResponse, status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const item = Buffer.from(chunk); size += item.length; if (size > 64 * 1024) throw Object.assign(new Error('Request body too large.'), { status: 413 }); chunks.push(item); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400 }); }
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
      const requestKey = req.headers['idempotency-key'];
      if (requestKey !== undefined && (typeof requestKey !== 'string' || requestKey.length > 180 || !/^[a-z0-9:._/-]+$/i.test(requestKey))) return send(res, 400, { error: 'idempotency-key must be 1–180 safe ASCII characters.' });
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500 ||
          !input.input || typeof input.input !== 'object' || Array.isArray(input.input) || Object.getPrototypeOf(input.input) !== Object.prototype) return send(res, 400, { error: 'title (1–500 characters) and a plain object input are required.' });
      const task = await worker.enqueue(input.title, input.input as never, requestKey || undefined);
      return send(res, 202, { id: task.id, status: task.status });
    }
    if(req.method==='POST'&&url.pathname==='/internal/checkpoints'){
      const input=await body(req);
      const hubTaskId=Number(input.hubTaskId),hubVillaId=Number(input.hubVillaId);
      const agentId=String(input.agentId||'');const sourceId=String(input.sourceCheckpointId||'');
      if(!Number.isSafeInteger(hubTaskId)||hubTaskId<1||!Number.isSafeInteger(hubVillaId)||hubVillaId<1||!agentId||agentId.length>160||!/^[a-f0-9]{64}$/i.test(sourceId)||!input.state||typeof input.state!=='object'||Array.isArray(input.state)||Object.getPrototypeOf(input.state)!==Object.prototype)return send(res,400,{error:'Invalid checkpoint mirror payload.'});
      const task=await prisma.agentTask.findFirst({where:{hubTaskId,hubVillaId},orderBy:{createdAt:'desc'},select:{id:true}});
      if(!task)return send(res,404,{error:'Mesh task is not registered.'});
      const state=input.state as Record<string,unknown>;
      const stepNumber=state.step===undefined?1:Number(state.step);
      if(!Number.isSafeInteger(stepNumber)||stepNumber<1)return send(res,400,{error:'Checkpoint step must be a positive integer.'});
      const saved=await checkpointStore.persistStep({taskId:task.id,agentId,stepNumber,
        toolName:String(state.lastTool||'agent.step').slice(0,160),arguments:{},result:{checkpointSourceId:sourceId},state,sourceId});
      return send(res,201,{checkpointId:saved.checkpointId,sequence:saved.sequence});
    }
    const match = url.pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i);
    if (req.method === 'GET' && match) {
      const task = await prisma.agentTask.findUnique({ where: { id: match[1]! }, select: { id: true, title: true, status: true, attempt: true, result: true, createdAt: true, updatedAt: true } });
      return task ? send(res, 200, task) : send(res, 404, { error: 'Task not found.' });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    const status = Number((error as { status?: number }).status) || 500;
    if (status >= 500) console.error('[agentforge-runtime] request failed', { method: req.method, path: req.url, code: (error as Error)?.name });
    return send(res, status, { error: status >= 500 ? 'Internal runtime error.' : String((error as Error).message).slice(0, 300) });
  }
});

async function start() {
  await AgentTelemetry.init();
  await prisma.$connect();
  void telemetryStore.prune().catch(error => console.error('[TelemetryRetention]', (error as Error).name));
  server.listen(port, '0.0.0.0');
  outboxTimer = setInterval(() => { void worker.flushOutbox().catch(error => console.error('[Outbox]', (error as Error).message)); }, 500);
  outboxTimer.unref();
  // Recover abandoned RUNNING rows periodically so a process restart or worker OOM
  // cannot leave a task stuck until another deployment.
  recoveryTimer = setInterval(() => { void worker.recoverStaleTasks().catch(error => console.error('[Recovery]', (error as Error).message)); }, 60_000);
  recoveryTimer.unref();
  telemetryRetentionTimer = setInterval(() => { void telemetryStore.prune().catch(error => console.error('[TelemetryRetention]', (error as Error).name)); }, 24 * 60 * 60 * 1000);
  telemetryRetentionTimer.unref();
  const concurrency=Math.max(1,Math.min(16,Number(process.env.AGENT_WORKER_CONCURRENCY)||3));
  void Promise.all(Array.from({length:concurrency},()=>worker.run(controller.signal)))
    .catch(error => console.error('[AgentWorker]', (error as Error).message));
  console.log(`[agentforge-runtime] listening on ${port}`);
}
async function shutdown() {
  controller.abort(); worker.stop();
  if (outboxTimer) clearInterval(outboxTimer);
  if (recoveryTimer) clearInterval(recoveryTimer);
  if (telemetryRetentionTimer) clearInterval(telemetryRetentionTimer);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.allSettled([bus.disconnect(), prisma.$disconnect(), AgentTelemetry.shutdown()]);
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
start().catch(error => { console.error('[agentforge-runtime] startup failed', error); process.exit(1); });
