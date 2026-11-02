import {spawnSync} from 'node:child_process';

const pinnedImagePattern=/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/;

export function projectSandboxPreflight({
 mode=process.env.VF_PROJECT_SANDBOX,
 image=process.env.VF_PROJECT_SANDBOX_IMAGE||'',
 inspectImage=(reference)=>spawnSync('docker',['image','inspect',reference,'--format','{{json .RepoDigests}}'],{encoding:'utf8',timeout:10000,windowsHide:true})
}={}){
 const checks={modeConfigured:mode==='docker',imagePinned:false,dockerAvailable:false,imagePresent:false};
 if(!mode)return {ready:false,code:'PROJECT_SANDBOX_REQUIRED',checks};
 if(mode!=='docker')return {ready:false,code:'PROJECT_SANDBOX_MODE_INVALID',checks};
 if(!pinnedImagePattern.test(image))return {ready:false,code:'PROJECT_SANDBOX_PINNED_IMAGE_REQUIRED',checks};
 checks.imagePinned=true;

 let result;
 try{result=inspectImage(image);}catch{return {ready:false,code:'PROJECT_SANDBOX_DOCKER_UNAVAILABLE',checks};}
 if(result?.error)return {ready:false,code:'PROJECT_SANDBOX_DOCKER_UNAVAILABLE',checks};
 checks.dockerAvailable=true;
 if(result?.status!==0)return {ready:false,code:'PROJECT_SANDBOX_IMAGE_NOT_PRESENT',checks};

 let repoDigests;
 try{repoDigests=JSON.parse(result.stdout);}catch{return {ready:false,code:'PROJECT_SANDBOX_IMAGE_METADATA_INVALID',checks};}
 if(!Array.isArray(repoDigests))return {ready:false,code:'PROJECT_SANDBOX_IMAGE_METADATA_INVALID',checks};
 checks.imagePresent=repoDigests.includes(image);
 return checks.imagePresent
  ? {ready:true,code:'PROJECT_SANDBOX_READY',checks}
  : {ready:false,code:'PROJECT_SANDBOX_IMAGE_DIGEST_MISMATCH',checks};
}
