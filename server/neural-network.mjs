import { db, now } from './db.mjs';
import { emit } from './events.mjs';

const PIPELINE = Object.freeze([
  ['ROOT', 'PLANNER'], ['PLANNER', 'RESEARCHER'], ['PLANNER', 'ARCHITECT'],
  ['RESEARCHER', 'ARCHITECT'], ['ARCHITECT', 'CODER'], ['CODER', 'TESTER'],
  ['TESTER', 'REVIEWER'], ['REVIEWER', 'INTEGRATOR'], ['INTEGRATOR', 'VERIFIER'],
  ['BUSINESS', 'GROWTH'], ['CRITIC', 'ARCHITECT'], ['VERIFIER', 'ROOT']
]);
const SPECIALISTS = new Set(['PLANNER','RESEARCHER','ARCHITECT','CODER','REVIEWER','TESTER','DOCUMENTER','CRITIC','INTEGRATOR','BUSINESS','GROWTH','STRATEGIST','REASONER','SYNTHESIZER','OPTIMIZER','VERIFIER','PROFI']);

function getVilla(villaId) {
  const id=Number(villaId);
  if(!Number.isSafeInteger(id)||id<=0) throw new Error('VILLA_NOT_FOUND');
  const villa=db.prepare('SELECT id,name,status,autonomy,max_agents FROM villas WHERE id=?').get(id);
  if(!villa) throw new Error('VILLA_NOT_FOUND');
  return villa;
}

/** Live topology is derived from the actual persisted Villa roster and task table. */
export function neuralNetworkStatus(villaId, { isRunning = () => false } = {}) {
  const villa=getVilla(villaId);
  const agents=db.prepare('SELECT id,name,role,status,is_root,parent_id,last_active_at FROM agents WHERE villa_id=? ORDER BY id').all(villa.id);
  const tasks=db.prepare('SELECT id,title,status,agent_id,priority,updated_at FROM tasks WHERE villa_id=? ORDER BY priority,id').all(villa.id);
  const roles=new Set(agents.map(a=>String(a.role||'WORKER').toUpperCase()));
  const edges=[];
  for(const [from,to] of PIPELINE) {
    const sources=agents.filter(a=>String(a.role||'').toUpperCase()===from);
    const targets=agents.filter(a=>String(a.role||'').toUpperCase()===to);
    if(!sources.length||!targets.length) continue;
    for(const source of sources.slice(0,8)) for(const target of targets.slice(0,8)) {
      if(source.id!==target.id) edges.push({from:source.id,to:target.id,kind:'workflow',label:from+' → '+to});
    }
  }
  for(const agent of agents) {
    if(agent.parent_id && agents.some(parent=>parent.id===agent.parent_id)) {
      if(!edges.some(e=>e.from===agent.parent_id&&e.to===agent.id)) edges.push({from:agent.parent_id,to:agent.id,kind:'supervision',label:'supervises'});
    }
  }
  const counts=Object.fromEntries(['PENDING','READY','RUNNING','REVIEW','DONE','FAILED','BLOCKED'].map(s=>[s,0]));
  for(const task of tasks) counts[task.status]=(counts[task.status]||0)+1;
  const assigned=new Map();
  for(const task of tasks) if(task.agent_id) assigned.set(task.agent_id,(assigned.get(task.agent_id)||0)+1);
  const nodes=agents.map(a=>({
    id:a.id,name:a.name,role:a.role,status:a.status,parentId:a.parent_id||null,
    workload:assigned.get(a.id)||0,lastActiveAt:Number(a.last_active_at)||0,
    specialist:SPECIALISTS.has(String(a.role||'').toUpperCase())
  }));
  return {
    villa:{id:villa.id,name:villa.name,status:villa.status,autonomy:!!villa.autonomy},
    network:{mode:villa.autonomy?'AUTONOMOUS':'STANDBY',running:!!isRunning(villa.id),nodes:nodes.length,edges:edges.length,roles:[...roles].sort()},
    nodes,edges,tasks:counts,
    coordination:{scheduler:'VillaForge scheduler',eventBus:'Redis Streams + SSE metadata mesh',memory:'Villa-scoped SQLite memory',recovery:'checkpoint + retry + dead-letter queue'},
    limits:{maxAgents:Number(villa.max_agents)||1000,parallelism:'bounded by scheduler and resource agent',externalEffects:'require existing permission gates'}
  };
}

/** Enable the existing production scheduler; no second worker pool is created. */
export async function activateNeuralNetwork(villaId, { scheduleVilla, isRunning = () => false } = {}) {
  if(typeof scheduleVilla!=='function') throw new Error('NETWORK_SCHEDULER_UNAVAILABLE');
  const villa=getVilla(villaId);
  if(villa.status==='ARCHIVED') throw new Error('VILLA_ARCHIVED');
  const previous=Number(villa.autonomy)||0;
  db.prepare('UPDATE villas SET autonomy=1,updated_at=? WHERE id=?').run(now(),villa.id);
  let scheduled;
  try {
    scheduled=scheduleVilla(villa.id,{concurrency:0,maxRounds:6,force:true});
    if(scheduled?.refused) throw Object.assign(new Error(scheduled.refusedMessage||'Scheduler hat den Start abgelehnt.'),{code:scheduled.refusedCode||'NETWORK_START_REFUSED'});
  } catch(error) {
    db.prepare('UPDATE villas SET autonomy=?,updated_at=? WHERE id=?').run(previous,now(),villa.id);
    throw error;
  }
  emit('neural.network.activated',{villaId:villa.id,nodes:Number(db.prepare('SELECT COUNT(*) c FROM agents WHERE villa_id=?').get(villa.id).c),queued:!!scheduled?.queue?.includes?.(villa.id)});
  return {...neuralNetworkStatus(villa.id,{isRunning}),accepted:true,scheduled};
}

/** Disable only the selected Villa and release its scheduler slot. */
export function deactivateNeuralNetwork(villaId, { cancelScheduledVilla = () => false, stopVilla = () => false, isRunning = () => false } = {}) {
  const villa=getVilla(villaId);
  const cancelled=!!cancelScheduledVilla(villa.id);
  const stopped=!!stopVilla(villa.id);
  db.prepare('UPDATE villas SET autonomy=0,status=?,updated_at=? WHERE id=?')
    .run(isRunning(villa.id)?'STOPPING':'PAUSED',now(),villa.id);
  emit('neural.network.deactivated',{villaId:villa.id,stopped,cancelled});
  return {...neuralNetworkStatus(villa.id,{isRunning}),accepted:true,stopped,cancelled};
}
