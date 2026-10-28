import { randomUUID } from 'node:crypto';
import { redisTryAck, redisTryClaimStale, redisTryCreateConsumerGroup, redisTryReadConsumerGroup, redisTryStreamAdd } from './redis.mjs';

export const AGENT_EVENT_STREAM = process.env.VF_AGENT_EVENT_STREAM || 'vf:agent-events';
const SAFE_FIELDS = ['villaId','taskId','agentId','status','tool','blocked','code','durationMs','latencyMs','tokensUsed','costUsd','provider','model','route','checkpointId','step','processed','open','verification'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Build metadata-only events; prompts, tool arguments, responses and thoughts are never persisted. */
export function buildMeshEvent(type, payload = {}, { now = Date.now, id = randomUUID } = {}) {
  const mapped = type === 'task' && payload.status === 'PENDING' ? 'task.created'
    : type === 'task' && payload.status === 'RUNNING' ? 'agent.step.started'
    : type === 'task' && payload.status === 'FAILED' ? 'agent.failed'
    : type === 'task' ? 'task.updated'
    : type === 'tool' ? 'tool.executed'
    : type === 'llm' ? 'llm.completed'
    : type === 'checkpoint' ? 'checkpoint.saved'
    : ['agent.step.started','agent.failed','checkpoint.saved','task.created','tool.executed','llm.failed'].includes(type) ? type : null;
  if (!mapped) return null;
  const metadata = {};
  for (const key of SAFE_FIELDS) {
    const value=payload[key];
    if (value==null) continue;
    if (typeof value==='boolean' || (typeof value==='number' && Number.isFinite(value))) metadata[key]=value;
    else if (typeof value==='string') metadata[key]=value.slice(0,160);
  }
  return { id:id(), type:mapped, at:now(), ...metadata };
}

export async function publishMeshEvent(type, payload) {
  const event=buildMeshEvent(type,payload);
  if (!event) return null;
  const result=await redisTryStreamAdd(AGENT_EVENT_STREAM,{type:event.type,json:JSON.stringify(event),eventId:event.id,at:event.at});
  void deliverExternalEvent(event);
  return result;
}

/** Forward the same hash-linked, secret-filtered checkpoint to PostgreSQL when configured. */
export async function publishRemoteCheckpoint(checkpoint) {
  const base=String(process.env.CYBERSARAH_TELEMETRY_URL||'').trim().replace(/\/+$/,'');
  const token=String(process.env.CYBERSARAH_TELEMETRY_TOKEN||'').trim();
  if(!base||!token) return false;
  try {
    const response=await fetch(`${base}/api/agentforge/checkpoints`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify(checkpoint),signal:AbortSignal.timeout(1500)});
    return response.ok;
  } catch { return false; }
}

async function deliverExternalEvent(event) {
  const base=String(process.env.CYBERSARAH_TELEMETRY_URL||'').trim().replace(/\/+$/,'');
  const token=String(process.env.CYBERSARAH_TELEMETRY_TOKEN||'').trim();
  if(!base||!token) return;
  try {
    await fetch(`${base}/api/agentforge/events`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify(event),signal:AbortSignal.timeout(1500)});
  } catch { /* remote dashboard is optional; local work and Redis stream continue */ }
}

/** One worker per agent/group. Polling is non-blocking so the existing shared RESP connection stays usable. */
export async function startAgentConsumer({ group, consumer, handler, signal, pollMs = 500, claimAfterMs = 30_000, onError = () => {} }) {
  if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(group||'') || !/^[a-zA-Z0-9:_-]{1,100}$/.test(consumer||'')) throw new Error('Invalid Redis consumer identity.');
  if (typeof handler!=='function') throw new Error('A consumer handler is required.');
  const created=await redisTryCreateConsumerGroup(AGENT_EVENT_STREAM,group);
  if (created==null) return { ok:false, reason:'redis_unavailable', stop:()=>{} };
  let stopped=false; let active=false;
  const stop=()=>{stopped=true;};
  const run=(async()=>{
    while(!stopped && !signal?.aborted) {
      if(active){await sleep(pollMs);continue;}
      active=true;
      try {
        let rows=await redisTryClaimStale(AGENT_EVENT_STREAM,group,consumer,{minIdleMs:claimAfterMs,count:10});
        if(rows==null) rows=await redisTryReadConsumerGroup(AGENT_EVENT_STREAM,group,consumer,{count:10});
        for(const row of rows||[]) {
          if(!row.event){await redisTryAck(AGENT_EVENT_STREAM,group,row.id);continue;}
          try { await handler(row.event); await redisTryAck(AGENT_EVENT_STREAM,group,row.id); }
          catch(error){try{onError({group,consumer,eventId:row.event.id,code:error?.code||'HANDLER_ERROR'});}catch{/* isolated */}}
        }
      } catch(error){try{onError({group,consumer,code:error?.code||'CONSUMER_ERROR'});}catch{/* isolated */}}
      finally {active=false;}
      if(!stopped && !signal?.aborted) await sleep(pollMs);
    }
  })();
  return { ok:true, stop, done:run };
}
