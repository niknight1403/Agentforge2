// Bounded transport adapters; existing endpoints only, no GPU allocation or billing API.
import {randomUUID} from 'node:crypto';
let inFlight=0;
const MAX_BYTES=1024*1024;
async function boundedText(response){
 if(!response.ok){await response.body?.cancel();const e=Error(`Remote worker HTTP ${response.status}`);e.status=response.status;throw e;}
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)throw Error('Remote worker result exceeds 1 MiB');chunks.push(Buffer.from(value));}}
 finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks).toString('utf8');
}
async function gradioResult(response){
 if(!response.ok)return boundedText(response);
 const reader=response.body?.getReader();if(!reader)throw Error('Empty Gradio stream');
 const decoder=new TextDecoder();let pending='',size=0;
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   size+=value.length;if(size>MAX_BYTES)throw Error('Remote worker result exceeds 1 MiB');
   pending+=decoder.decode(value,{stream:true});
   pending=pending.replace(/\r\n/g,'\n');
   let end;
   while((end=pending.indexOf('\n\n'))>=0){
    const event=pending.slice(0,end);pending=pending.slice(end+2);
    const type=event.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim();
    if(type==='error')throw Error('Remote Gradio execution failed');
    if(type==='complete')return JSON.parse(event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n'));
   }
  }
  throw Error('Gradio stream ended without a complete event');
 }finally{await reader.cancel().catch(()=>{});}
}
export async function executeRemoteWorker(task,input,{env=process.env,transport=fetch,signal}={}){
 if(!env.VF_REMOTE_WORKER_URL)throw Error('Kein Remote-Worker konfiguriert. Lokale Arbeit bleibt verfügbar.');
 if(inFlight>=1)throw Error('Remote-Worker ausgelastet; Auftrag wurde nicht übertragen.');
 const base=new URL(env.VF_REMOTE_WORKER_URL);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('Invalid remote worker URL');
 if(typeof task!=='string'||!task.trim()||task.length>200)throw Error('A task name of 1..200 characters is required');
 const protocol=env.VF_REMOTE_WORKER_PROTOCOL||'json';if(!['json','gradio'].includes(protocol))throw Error('Supported worker protocols: json, gradio');
 const body=JSON.stringify(protocol==='gradio'?{data:input}:{task,input,requestId:randomUUID()});if(Buffer.byteLength(body)>256*1024)throw Error('Remote input exceeds 256 KiB; use an authorized artifact URL');
 const timeout=Number(env.VF_REMOTE_WORKER_TIMEOUT_MS||120000);if(!Number.isFinite(timeout)||timeout<1000||timeout>300000)throw Error('Worker timeout must be 1000..300000 ms');
 const deadline=AbortSignal.any([AbortSignal.timeout(timeout),...(signal?[signal]:[])]);
 const headers={'content-type':'application/json',...(env.VF_REMOTE_WORKER_TOKEN?{authorization:`Bearer ${env.VF_REMOTE_WORKER_TOKEN}`}:{})};
 const call=async(url,options={})=>boundedText(await transport(url,{...options,headers,signal:deadline,redirect:'error'}));
 inFlight++;
 try{
  if(protocol==='json')return JSON.parse(await call(base,{method:'POST',body}));
  if(!Array.isArray(input))throw Error('Gradio input must be a positional data array');
  const api=env.VF_REMOTE_WORKER_API||'predict';if(!/^[a-zA-Z0-9_-]+$/.test(api))throw Error('Invalid Gradio API name');
  const endpoint=base.href.replace(/\/$/,'')+'/call/'+api;
  const {event_id}=JSON.parse(await call(endpoint,{method:'POST',body}));
  if(typeof event_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(event_id))throw Error('Gradio did not return an event ID');
  return await gradioResult(await transport(endpoint+'/'+event_id,{headers,signal:deadline,redirect:'error'}));
 }finally{inFlight--;}
}
