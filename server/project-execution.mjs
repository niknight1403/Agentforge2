import {randomUUID} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
/** Opt-in isolated execution; never downloads images or falls back on failure. */
function defaultMode(){
 // Projektcode ist nicht Teil des vertrauenswuerdigen Hub-Releases. Eine
 // Produktionsinstanz darf ihn deshalb nur nach expliziter Sandbox-Freigabe
 // ausfuehren. Entwicklung und Tests behalten ihren bisherigen Host-Modus.
 if(process.env.VF_PROJECT_SANDBOX)return process.env.VF_PROJECT_SANDBOX;
 return process.env.NODE_ENV==='production'?'required':'host';
}
export function projectExecution(root,binary,args,{mode=defaultMode(),image=process.env.VF_PROJECT_SANDBOX_IMAGE||''}={}){
 if(mode==='host')return {binary,args};
 if(mode==='required')throw Error('PROJECT_SANDBOX_REQUIRED');
 if(mode!=='docker')throw Error('PROJECT_SANDBOX_MODE_INVALID');
 if(!/^(?:[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(image))throw Error('PROJECT_SANDBOX_PINNED_IMAGE_REQUIRED');
 const source=realpathSync(root);
 if(source==='/'||/[\r\n,]/.test(source))throw Error('PROJECT_SANDBOX_WORKSPACE_INVALID');
 const cache=process.env.VF_NPM_CACHE_DIR?realpathSync(process.env.VF_NPM_CACHE_DIR):'';
 if(cache&&(!statSync(cache).isDirectory()||cache==='/'||/[\r\n,]/.test(cache)))throw Error('PROJECT_SANDBOX_NPM_CACHE_INVALID');
 const uid=process.getuid?.()>0?process.getuid():1000;
 const gid=process.getgid?.()>0?process.getgid():1000;
 const name='vf-project-'+randomUUID();
 return {cleanup:{binary:'docker',args:['rm','--force',name]},binary:'docker',args:['run','--name',name,'--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=128','--memory=1g','--cpus=1','--user='+uid+':'+gid,'--tmpfs=/tmp:rw,nosuid,nodev,size=256m','--mount','type=bind,source='+source+',target=/workspace',...(cache?['--mount','type=bind,source='+cache+',target=/npm-cache']:[]),'--workdir=/workspace','--env=CI=1','--env=HOME=/tmp','--env=LANG=C.UTF-8','--env=PYTHONUNBUFFERED=1',image,binary,...args]};
}
