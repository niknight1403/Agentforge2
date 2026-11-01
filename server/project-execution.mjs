import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
/** Opt-in isolated execution; never downloads images or falls back on failure. */
export function projectExecution(root,binary,args,{mode=process.env.VF_PROJECT_SANDBOX||'host',image=process.env.VF_PROJECT_SANDBOX_IMAGE||''}={}){
 if(mode==='host')return {binary,args};
 if(mode!=='docker')throw Error('PROJECT_SANDBOX_MODE_INVALID');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(image))throw Error('PROJECT_SANDBOX_PINNED_IMAGE_REQUIRED');
 const source=realpathSync(root);
 if(source==='/'||/[\r\n,]/.test(source))throw Error('PROJECT_SANDBOX_WORKSPACE_INVALID');
 const uid=process.getuid?.()>0?process.getuid():1000;
 const gid=process.getgid?.()>0?process.getgid():1000;
 const name='vf-project-'+randomUUID();
 return {cleanup:{binary:'docker',args:['rm','--force',name]},binary:'docker',args:['run','--name',name,'--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=128','--memory=1g','--cpus=1','--user='+uid+':'+gid,'--tmpfs=/tmp:rw,nosuid,nodev,size=256m','--mount','type=bind,source='+source+',target=/workspace','--workdir=/workspace','--env=CI=1','--env=HOME=/tmp',image,binary,...args]};
}
