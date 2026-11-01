import {mkdtempSync,mkdirSync,readdirSync,lstatSync,readFileSync,writeFileSync,chmodSync,realpathSync,existsSync,rmSync} from 'node:fs';
import {join,relative,isAbsolute,sep} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
const excluded=new Set(['.git','.vf-builds','dist','build','node_modules']);
function scan(root,copyTo,{artifact=false,writable=false}={}){
 const hash=createHash('sha256');let bytes=0,files=0;
 function walk(dir){
  for(const name of readdirSync(dir).sort()){
   if(!artifact&&(excluded.has(name)||name.startsWith('.env')))continue;
   if(artifact&&name.startsWith('.env'))throw Error('SANDBOX_ARTIFACT_SECRET_FILE');
   const full=join(dir,name),st=lstatSync(full),rel=relative(root,full);
   if(st.isSymbolicLink()||(!st.isDirectory()&&!st.isFile()))throw Error('SANDBOX_UNSAFE_FILE');
   if(st.isDirectory()){if(copyTo){mkdirSync(join(copyTo,rel),{recursive:true,mode:0o755});if(writable)chmodSync(join(copyTo,rel),0o777);}walk(full);continue;}
   if(++files>2000||(bytes+=st.size)>32*1024*1024)throw Error('SANDBOX_COPY_BUDGET');
   const data=readFileSync(full);hash.update(rel+'\0').update(data);
   if(copyTo){writeFileSync(join(copyTo,rel),data,{mode:0o644});if(writable)chmodSync(join(copyTo,rel),0o666);}
  }
 }
 walk(root);return hash.digest('hex');
}
export function prepareProjectStage(root){
 root=realpathSync(root);const owner=mkdtempSync(join(tmpdir(),'vf-stage-')),work=join(owner,'project');mkdirSync(work,{mode:0o777});chmodSync(work,0o777);
 try{const fingerprint=scan(root,work,{writable:true});if(scan(root)!==fingerprint)throw Error('SANDBOX_SOURCE_CHANGED');return {root,owner,work,fingerprint};}
 catch(error){rmSync(owner,{recursive:true,force:true});throw error;}
}
export function collectProjectStage(stage){
 if(scan(stage.root)!==stage.fingerprint)throw Error('SANDBOX_SOURCE_CHANGED');
 const outputs=['dist','build'].filter(name=>existsSync(join(stage.work,name)));
 if(!outputs.length)return null;
 // Validate output independently: symlinks, special files and budgets stay blocked.
 for(const name of outputs){const src=join(stage.work,name);if(!lstatSync(src).isDirectory()||lstatSync(src).isSymbolicLink())throw Error('SANDBOX_UNSAFE_OUTPUT');scan(src,undefined,{artifact:true});}
 const parent=join(stage.root,'.vf-builds');
 if(existsSync(parent)&&(!lstatSync(parent).isDirectory()||lstatSync(parent).isSymbolicLink()))throw Error('SANDBOX_ARTIFACT_PARENT');
 mkdirSync(parent,{recursive:true,mode:0o700});
 const directory=mkdtempSync(join(parent,'run-'));
 try{
  for(const name of outputs){const dest=join(directory,name);mkdirSync(dest);scan(join(stage.work,name),dest,{artifact:true});}
  if(scan(stage.root)!==stage.fingerprint)throw Error('SANDBOX_SOURCE_CHANGED');
  return {directory,fingerprint:stage.fingerprint,outputs,digests:Object.fromEntries(outputs.map(name=>[name,scan(join(directory,name),undefined,{artifact:true})]))};
 }catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}
export function disposeProjectStage(stage){rmSync(stage.owner,{recursive:true,force:true});}

export function validStageArtifacts(root,artifacts){
 try{
  const base=realpathSync(root),dir=realpathSync(artifacts.directory),rel=relative(base,dir);
  const parts=rel.split(sep);if(isAbsolute(rel)||parts.length!==2||parts[0]!=='.vf-builds'||!/^run-[A-Za-z0-9]+$/.test(parts[1])||lstatSync(artifacts.directory).isSymbolicLink())return false;
  if(scan(base)!==artifacts.fingerprint||!Array.isArray(artifacts.outputs)||!artifacts.outputs.length)return false;
  return artifacts.outputs.every(name=>['dist','build'].includes(name)&&!lstatSync(join(dir,name)).isSymbolicLink()&&scan(join(dir,name),undefined,{artifact:true})===artifacts.digests?.[name]);
 }catch{return false;}
}
