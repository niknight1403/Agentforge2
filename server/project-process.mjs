import {execFile} from 'node:child_process';
/** Deadline and cleanup do not depend on an attached Docker CLI exiting. */
export function executeInvocation(invocation,options,callback,{exec=execFile,cleanupTimeoutMs=10000}={}){
 if(!invocation.cleanup)return exec(invocation.binary,invocation.args,options,callback);
 let child,settled=false,delivered=false;
 const deliver=(error,stdout='',stderr='')=>{if(delivered)return;delivered=true;callback(error,stdout,stderr);};
 const settle=(error,stdout='',stderr='')=>{
  if(settled)return;settled=true;clearTimeout(deadline);
  const cleanupDeadline=setTimeout(()=>deliver(Object.assign(Error('Sandbox cleanup deadline exceeded'),{code:'SANDBOX_CLEANUP_TIMEOUT'}),stdout,stderr),cleanupTimeoutMs+1000);
  try{exec(invocation.cleanup.binary,invocation.cleanup.args,{timeout:cleanupTimeoutMs,killSignal:'SIGKILL',maxBuffer:100000,env:{PATH:process.env.PATH,HOME:process.env.HOME}},cleanupError=>{
   clearTimeout(cleanupDeadline);deliver(error|| (cleanupError?Object.assign(Error('Sandbox cleanup failed'),{code:'SANDBOX_CLEANUP_FAILED'}):null),stdout,stderr);
  });}catch{clearTimeout(cleanupDeadline);deliver(Object.assign(Error('Sandbox cleanup failed'),{code:'SANDBOX_CLEANUP_FAILED'}),stdout,stderr);}
 };
 const deadline=setTimeout(()=>{
  try{child?.kill('SIGKILL');}catch{}
  settle(Object.assign(Error('Project command timed out'),{code:'ETIMEDOUT'}));
 },Math.max(1,Number(options.timeout)||120000));
 try{child=exec(invocation.binary,invocation.args,{...options,killSignal:'SIGKILL'},settle);}catch(error){settle(error);}
 return child;
}
