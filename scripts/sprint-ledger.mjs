/** Durable foreground sprint ledger; does not simulate background execution. */
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const defaultRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function readLedger(root=defaultRoot){
 const backlog=JSON.parse(readFileSync(resolve(root,'docs/sprints/backlog.json'),'utf8'));
 const state=JSON.parse(readFileSync(resolve(root,'docs/sprints/state.json'),'utf8'));
 if(backlog.schemaVersion!==1||state.schemaVersion!==1||backlog.sprints.length!==500)throw Error('Invalid sprint ledger schema.');
 const ids=new Set();for(const s of backlog.sprints){if(!/^VF-\d{4}$/.test(s.id)||ids.has(s.id))throw Error('Invalid or duplicate sprint ID.');ids.add(s.id);if(s.status==='done'&&(!s.scopeDefined||!s.goal||!s.acceptanceCriteria.length||!s.evidence.length||!/^[a-f0-9]{40}$/.test(s.implementationCommit||'')))throw Error('Completed sprint requires scoped acceptance, commit and evidence.');}
 return {backlog,state};
}
export function completeSprint({root=defaultRoot,id,commit,evidencePath}){
 const {backlog,state}=readLedger(root),s=backlog.sprints.find(x=>x.id===id);
 if(!s?.scopeDefined||!s.goal||!s.acceptanceCriteria.length)throw Error('Sprint scope is not defined.');
 if(!/^[a-f0-9]{40}$/.test(commit||''))throw Error('A real implementation commit SHA is required.');
 if(s.dependencies.some(id=>backlog.sprints.find(x=>x.id===id)?.status!=='done'))throw Error('Sprint dependency is not complete.');
 const evidence=resolve(root,evidencePath||'');if(!evidence.startsWith(resolve(root,'docs/sprints/evidence')+'/')||!existsSync(evidence))throw Error('Evidence file is required within docs/sprints/evidence.');
 const result=JSON.parse(readFileSync(evidence,'utf8'));if(result.exitCode!==0)throw Error('Evidence gate did not pass.');
 s.status='done';s.implementationCommit=commit;s.evidence=[evidencePath];
 state.completed=backlog.sprints.filter(x=>x.status==='done').map(x=>x.id);state.current=null;state.next=backlog.sprints.find(x=>x.status!=='done')?.id||null;
 for(const [name,data] of [['backlog',backlog],['state',state]]){const path=resolve(root,`docs/sprints/${name}.json`);writeFileSync(path+'.tmp',JSON.stringify(data,null,2)+'\n');renameSync(path+'.tmp',path);}
 return state;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const action=process.argv[2]||'status';if(action==='complete')console.log(JSON.stringify(completeSprint({id:process.argv[3],commit:process.argv[4],evidencePath:process.argv[5]}),null,2));else if(action==='status'){const {backlog,state}=readLedger();console.log(JSON.stringify({...state,completed:backlog.sprints.filter(x=>x.status==='done').map(x=>x.id),scoped:backlog.sprints.filter(x=>x.scopeDefined).length,reserved:backlog.sprints.filter(x=>!x.scopeDefined).length},null,2));}else throw Error('Use status or complete ID COMMIT EVIDENCE.');}catch(e){console.error(e.message);process.exitCode=1;}
}
