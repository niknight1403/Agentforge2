import {spawnSync} from 'node:child_process';

const SPECS=Object.freeze([
 {id:'git',binary:'git',args:['--version'],family:'development'},
 {id:'node',binary:'node',args:['--version'],family:'development'},
 {id:'python',binary:'python3',args:['--version'],family:'development'},
 {id:'java',binary:'java',args:['-version'],family:'android'},
 {id:'flutter',binary:'flutter',args:['--version'],family:'android'},
 {id:'adb',binary:'adb',args:['version'],family:'android'},
 {id:'ffmpeg',binary:'ffmpeg',args:['-version'],family:'media'},
 {id:'ffprobe',binary:'ffprobe',args:['-version'],family:'media'},
 {id:'imagemagick',binary:'magick',args:['-version'],family:'image'},
 {id:'docker',binary:'docker',args:['--version'],family:'infrastructure'},
 {id:'ollama',binary:'ollama',args:['--version'],family:'model'}
]);
/** Read-only, allowlisted executable probes. Never run a command derived from prompts. */
export function runtimeCapabilityInventory({run=spawnSync}={}){
 return SPECS.map(spec=>{
  let result;
  try{result=run(spec.binary,spec.args,{encoding:'utf8',timeout:1800,maxBuffer:16384,windowsHide:true,shell:false});}
  catch(error){return {id:spec.id,family:spec.family,status:'unavailable',reason:String(error.code||'PROBE_FAILED')};}
  if(result.error||result.status!==0){
   return {id:spec.id,family:spec.family,status:'unavailable',reason:String(result.error?.code||result.signal||'EXIT_'+result.status)};
  }
  const version=String(result.stdout||result.stderr||'').split(/\r?\n/)[0].trim().slice(0,160);
  return {id:spec.id,family:spec.family,status:'available',version,verification:'binary-version-probe-only'};
 });
}
