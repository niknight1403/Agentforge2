import { createHash } from 'node:crypto';
import { saveCheckpoint, recoverCheckpoint } from './checkpoints.mjs';

const stable = value => JSON.stringify(value, (_key, v) => v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');

/** Bounded execution supervisor: timeout, prompt repair, loop detection, checkpoints. */
export async function runSupervisedTask({ taskId, agentId, initialState = {}, maxSteps = 80, timeoutMs = 300_000, step, validate = () => ({ ok: true }), onEvent = () => {}, clock = Date.now, signal }) {
  if (typeof step !== 'function') throw new Error('A step function is required.');
  const started=clock(); const recovery=recoverCheckpoint(taskId,agentId); let state=recovery?.state?.state || initialState;
  const emit=event=>{try{onEvent(event);}catch{/* telemetry must never break agent execution */}};
  if(recovery?.state?.status==='completed')return {status:'completed',state,steps:recovery.state.cursor??recovery.sequence,checkpointId:recovery.checkpointId,recovered:true};
  let promptHint=''; const repeated=new Map(); let lastStateHash=hash(state);
  for (let index=(Number.isSafeInteger(recovery?.state?.cursor)?recovery.state.cursor:recovery?.sequence||0); index<maxSteps; index++) {
    if(signal?.aborted)return {status:'cancelled',state,steps:index};
    const remaining=timeoutMs-(clock()-started);
    if (remaining<=0) return { status:'timeout',state,steps:index };
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(new Error('Supervisor timeout')),remaining);
    const onAbort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',onAbort,{once:true});
    emit({type:'agent.step.started',taskId,agentId,step:index+1});
    let result,verdict;
    const aborted=new Promise((_,reject)=>{if(controller.signal.aborted)reject(controller.signal.reason);else controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});});
    try {
      result=await Promise.race([Promise.resolve().then(()=>step({taskId,agentId,state,promptHint,attempt:index+1,signal:controller.signal})),aborted]);
      verdict=await Promise.race([Promise.resolve().then(()=>validate(result,result?.state??state)),aborted]);
    }
    catch (error) {
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      if(signal?.aborted)return {status:'cancelled',state,steps:index};
      if(controller.signal.aborted)return {status:'timeout',state,steps:index};
      promptHint=`Previous attempt failed (${String(error?.code||error?.name||'error')}). Use a different safe approach and return a verifiable state delta.`;
      emit({type:'agent.failed',taskId,agentId,step:index+1,code:String(error?.code||error?.name||'ERROR')});
      if(index+1>=maxSteps) return {status:'failed',state,steps:index+1,errorCode:String(error?.code||error?.name||'ERROR')};
      continue;
    }
    clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
    if(signal?.aborted)return {status:'cancelled',state,steps:index};
    const nextState=result?.state ?? state; const nextHash=hash(nextState);
    if(result?.toolCall && nextHash===lastStateHash) {
      const fingerprint=hash(result.toolCall); const count=(repeated.get(fingerprint)||0)+1; repeated.set(fingerprint,count);
      if(count>=3) return {status:'loop_detected',state,steps:index+1,toolCall:result.toolCall.name||'unknown'};
    } else if(nextHash!==lastStateHash) repeated.clear();
    state=nextState; lastStateHash=nextHash;
    if(signal?.aborted)return {status:'cancelled',state,steps:index};
    const checkpoint=saveCheckpoint({taskId,agentId,state:{status:result?.done&&verdict?.ok!==false?'completed':'running',cursor:index+1,completed:result?.completed||[],artifactRefs:result?.artifactRefs||[],state}});
    emit({type:'checkpoint.saved',taskId,agentId,checkpointId:checkpoint.checkpointId,step:index+1});
    if(result?.done && verdict?.ok!==false) return {status:'completed',state,steps:index+1,checkpointId:checkpoint.checkpointId};
    if(verdict?.ok===false) promptHint=`Validation failed: ${(verdict.errors||[]).join('; ').slice(0,600)}. Repair the specific failed acceptance criteria.`;
    else promptHint='Continue from the saved state; do not repeat the same tool call without a state change.';
  }
  return {status:'step_limit',state,steps:maxSteps};
}
