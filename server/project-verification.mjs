import {existsSync,readdirSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {db,now} from './db.mjs';
import {runCommand} from './fs-tools.mjs';
import {calculateQualityGate,staticPerformanceScore,staticSecurityScore} from './quality-gate.mjs';
export const PROJECT_WORKSPACE=resolve(process.env.VF_WORKSPACE||'server/data/workspace');
export function ownProjectDir(id){return join(PROJECT_WORKSPACE,`villa-${id}`,'project');}
export function projectDirectory(id){
 const source=db.prepare('SELECT source_path FROM villas WHERE id=?').get(id)?.source_path;
 if(source)return resolve(source);
 const own=ownProjectDir(id);if(existsSync(own))return own;
 const legacy=join(PROJECT_WORKSPACE,`villa-${id}`);
 if(['package.json','pyproject.toml','gradlew','index.html'].some(f=>existsSync(join(legacy,f))))return legacy;
 return own;
}
db.exec(`CREATE TABLE IF NOT EXISTS project_verifications(villa_id INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL,checks TEXT NOT NULL,blockers TEXT NOT NULL,verified_at INTEGER NOT NULL)`);
const ignored=new Set(['node_modules','.git','.gradle','.next','.venv','venv','__pycache__','dist','build','out','coverage','backups']);
const textExtensions=/\.(?:[cm]?js|jsx|tsx?|py|kt|kts|java|dart|go|rs|html|css|json|md|ya?ml|toml|txt|lock|xml|properties|gradle)$/i;
export function inspectProject(id){
 const root=projectDirectory(id),hash=createHash('sha256'),files=[],securityFindings=[];let bytes=0,sourceFiles=0;
 try {
  const canonical=realpathSync(root);
  function walk(dir,depth=0){
   if(depth>20)throw Error('Projektbaum zu tief');
   for(const name of readdirSync(dir).sort()){
    if(ignored.has(name)||name.startsWith('.env'))continue;
    const file=join(dir,name),st=lstatSync(file);
    if(st.isSymbolicLink())throw Error('Verlinkte Projektdateien zuerst explizit auflösen');
    if(st.isDirectory()){walk(file,depth+1);continue;}
    if(!st.isFile()||!(textExtensions.test(name)||name==='gradlew'))continue;
    if(files.length>=2000||bytes+st.size>32*1024*1024)throw Error('Projektumfang überschreitet die automatische Prüfbudget-Grenze');
    const rel=file.slice(root.length+1);files.push(rel);bytes+=st.size;const content=readFileSync(file);hash.update(rel+'\0').update(content);
    const isSource=/\.(?:[cm]?js|jsx|tsx?|py|kt|java|dart|go|rs|html)$/i.test(name)&&!/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(rel);
    if(isSource){
     sourceFiles++;
     const text=content.toString('utf8');
     const hardSecret=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:API_KEY|SECRET|TOKEN)\s*[:=]\s*['"][^'"]{12,}['"]/i;
     if(hardSecret.test(text))securityFindings.push(rel);
    }
   }
  }
  walk(root);return {root:canonical,files,bytes,sourceFiles,securityFindings,fingerprint:hash.update(canonical).digest('hex')};
 }catch(e){return {root,files,bytes,sourceFiles:0,securityFindings,fingerprint:'',error:existsSync(root)?e.message:'Projektordner fehlt'};}
}
export function projectReadiness(id){
 const project=inspectProject(id),blockers=[];
 if(project.error)blockers.push(project.error);
 if(!project.sourceFiles)blockers.push('Keine ausführbare Implementierung im Projektordner gefunden');
 const row=db.prepare('SELECT * FROM project_verifications WHERE villa_id=?').get(id);
 const fresh=!!row && !!project.fingerprint && row.fingerprint===project.fingerprint && now()-row.verified_at<24*60*60*1000;
 let checks={};if(fresh){try{checks=JSON.parse(row.checks);if(row.status!=='passed')blockers.push(...JSON.parse(row.blockers));}catch{blockers.push('Prüfnachweis ungültig');}}
 if(row&&!fresh)blockers.push('Prüfnachweis veraltet oder Quellstand geändert');
 for(const kind of ['build','tests','smoke'])if(checks[kind]?.status!=='passed')blockers.push(`${kind}: ${checks[kind]?.reason||'kein aktueller erfolgreicher Nachweis'}`);
 const quality=calculateQualityGate({
  syntax:checks.build?.status==='passed'?100:0,
  tests:checks.tests?.status==='passed'&&checks.smoke?.status==='passed'?100:checks.tests?.status==='passed'?50:0,
  security:staticSecurityScore(project.securityFindings),
  performance:staticPerformanceScore(project.bytes),
 });
 if(fresh&&!quality.passed)blockers.push(`Quality Gate: ${quality.score}/100 < ${quality.threshold}`);
 const verified=blockers.length===0&&quality.passed;
 return {verified,status:verified?'verified':fresh?'blocked':'unverified',blockers,checks,quality,verifiedAt:fresh?row.verified_at:null,fingerprint:project.fingerprint,sourceFiles:project.sourceFiles};
}
const noOp=/^\s*(?:echo\b|exit\s+0\b|(?:true|:)\s*$)/i;
export function verificationPlan(root){
 let custom;
 try{custom=JSON.parse(readFileSync(join(root,'villaforge.verify.json'),'utf8'));}catch{}
 let pkg;try{pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));}catch{}
 return Object.fromEntries(['build','tests','smoke'].map(kind=>{
  const explicit=custom?.[kind];
  if(explicit && typeof explicit.binary==='string'&&Array.isArray(explicit.args)&&explicit.args.length<=20&&explicit.args.every(a=>typeof a==='string'&&a.length<=1000))return [kind,explicit];
  const script=kind==='tests'?'test':kind;
  if(pkg?.scripts?.[script]&&!noOp.test(pkg.scripts[script]))return [kind,{binary:'npm',args:['run',script]}];
  return [kind,null];
 }));
}
function saveVerification(id,project,checks,blockers){
 const passed=blockers.length===0;
 db.prepare('INSERT OR REPLACE INTO project_verifications VALUES (?,?,?,?,?,?)').run(id,project.fingerprint||'',passed?'passed':'blocked',JSON.stringify(checks),JSON.stringify(blockers),now());
 return {ok:passed,checks,blockers};
}
const verifying=new Map();
export async function verifyProjectRuntime(id,{runner=runCommand}={}){
 if(verifying.has(id))return verifying.get(id);
 const job=(async()=>{
  const project=inspectProject(id),checks={},blockers=[];
  if(project.error||!project.sourceFiles){blockers.push(project.error||'Keine ausführbare Implementierung');return saveVerification(id,project,checks,blockers);}
  const plan=verificationPlan(project.root);
  for(const kind of ['build','tests','smoke']){
   if(!plan[kind]){checks[kind]={status:'missing',reason:'Prüfbefehl fehlt (package.json oder villaforge.verify.json)'};blockers.push(`${kind}: Prüfbefehl fehlt`);continue;}
   const {binary,args}=plan[kind];let result;
   try{result=await runner(project.root,binary,args,180000);}catch{result={ok:false,error:'Prüfprozess nicht ausführbar'};}
   checks[kind]={status:result.ok?'passed':'failed',command:[binary,...args],output:String(result.output||result.error||'').slice(-2000)};
   if(!result.ok)blockers.push(`${kind}: fehlgeschlagen`);
  }
  const after=inspectProject(id);
  if(after.fingerprint!==project.fingerprint)blockers.push('Quellstand während der Prüfung verändert; erneut prüfen');
  return saveVerification(id,project,checks,blockers);
 })();
 verifying.set(id,job);try{return await job;}finally{verifying.delete(id);}
}
/** Deterministic repair work before growth waves; successful checks never come from task titles. */
export function ensureVerificationTasks(id){
 const ready=projectReadiness(id);if(ready.verified)return 0;
 const title='[VERIFICATION] Lauffähiges Produkt mit Build, Tests und Nutzerfluss nachweisen';
 const existing=db.prepare("SELECT id,status FROM tasks WHERE villa_id=? AND title=? ORDER BY id DESC LIMIT 1").get(id,title);
 const description='Keine weiteren Planungsberichte. '+ready.blockers.join('; ')+'. Implementiere fehlende Dateien und funktionierende Befehle build, test und smoke in package.json oder villaforge.verify.json. Smoke prüft den wichtigsten echten Nutzerfluss einschließlich Fehlerfall. Führe alle Prüfungen aus. Dokumentiere Start/Installation. Rolle: INTEGRATOR. Akzeptanz: Prüfungen am unveränderten Quellstand erfolgreich; kein Echo- oder Platzhaltertest.';
 if(existing){if(['DONE','FAILED'].includes(existing.status))db.prepare("UPDATE tasks SET status='PENDING',description=?,updated_at=? WHERE id=?").run(description,now(),existing.id);return 0;}
 db.prepare('INSERT INTO tasks(villa_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,\'PENDING\',1,?,?)').run(id,title,description,now(),now());return 1;
}
