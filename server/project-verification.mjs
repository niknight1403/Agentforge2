import {validStageArtifacts} from './project-stage.mjs';
import {existsSync,readdirSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {calculateQualityGate,scoreStandaloneHtmlPerformance,scoreStandaloneHtmlSecurity} from './quality-gate.mjs';
import {db,now} from './db.mjs';
import {runCommand} from './fs-tools.mjs';
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
const ignored=new Set(['.vf-builds','node_modules','.git','.gradle','.next','.venv','venv','__pycache__','dist','build','out','coverage','backups']);
const textExtensions=/\.(?:[cm]?js|jsx|tsx?|py|kt|kts|java|dart|go|rs|html|css|json|md|ya?ml|toml|txt|lock|xml|properties|gradle)$/i;
export function inspectProject(id){
 const root=projectDirectory(id),hash=createHash('sha256'),files=[];let bytes=0,sourceFiles=0;
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
    const rel=file.slice(root.length+1);files.push(rel);bytes+=st.size;hash.update(rel+'\0').update(readFileSync(file));
    if(/\.(?:[cm]?js|jsx|tsx?|py|kt|java|dart|go|rs|html)$/i.test(name)&&!/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(rel))sourceFiles++;
   }
  }
  walk(root);return {root:canonical,files,sourceFiles,fingerprint:hash.update(canonical).digest('hex')};
 }catch(e){return {root,files,sourceFiles:0,fingerprint:'',error:existsSync(root)?e.message:'Projektordner fehlt'};}
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
 if(checks.build?.artifacts&&!validStageArtifacts(project.root,checks.build.artifacts))blockers.push('build: Sandbox-Artefakt oder Quellstand veraendert; erneut pruefen');
 const verified=blockers.length===0;
 return {verified,status:verified?'verified':fresh?'blocked':'unverified',blockers,checks,verifiedAt:fresh?row.verified_at:null,fingerprint:project.fingerprint,sourceFiles:project.sourceFiles};
}
const noOp=/^\s*(?:echo\b|exit\s+0\b|(?:true|:)\s*$)/i;
function isNoOp(binary,args=[]){
 if(noOp.test(binary))return true;
 if(!/^(?:node|nodejs|python3?|sh|bash)$/.test(binary))return false;
 const flag=args.findIndex(a=>['-e','--eval','-c'].includes(a));
 if(flag<0)return false;
 const code=args[flag+1]||'';
 // Reject constant-success snippets, while keeping assertions and real work executable.
 const statements=code.split(';').map(s=>s.trim()).filter(Boolean);
 return statements.length===0||statements.every(s=>/^(?:console\.log|print)\(\s*(['"])[^'"\n]*\1\s*\)$/.test(s)||/^(?:process\.exit|sys\.exit)\(0\)$/.test(s));
}
function isNoOpScript(script){
 if(noOp.test(script))return true;
 const inline=script.match(/^\s*(node(?:js)?|python3?)\s+(?:-e|--eval|-c)\s+(['"])([\s\S]*)\2\s*$/);
 return !!inline&&isNoOp(inline[1],['-e',inline[3]]);
}
export function verificationPlan(root){
 let custom;
 try{custom=JSON.parse(readFileSync(join(root,'villaforge.verify.json'),'utf8'));}catch{}
 let pkg;try{pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));}catch{}
 // Ein abgelehnter Platzhalter wird als solcher zurueckgemeldet, nicht als
 // fehlender Befehl: der Agent muss sonst raten, warum sein Skript nicht zaehlt,
 // und schreibt immer wieder neue Platzhalter (Villa 8 kam so auf 34 Versuche).
 // Vorrang: ein echter Befehl im package.json des Projekts gewinnt gegen die
 // ops-seitige villaforge.verify.json. Sonst wuerde der Agent seinen eigenen,
 // korrekten Build setzen und die Abnahme weiter den alten Befehl fahren -
 // genau dieser Widerspruch hat Reparaturrunden blockiert.
 return Object.fromEntries(['build','tests','smoke'].map(kind=>{
  const script=kind==='tests'?'test':kind;
  const befehl=pkg?.scripts?.[script];
  const ausPkg=typeof befehl==='string'?(isNoOpScript(befehl)?{invalid:`package.json: "${script}" ist ein Platzhalter ("${befehl.slice(0,90)}") und zaehlt nicht als Nachweis`}:{binary:'npm',args:['run',script]}):null;
  const explicit=custom?.[kind];
  const ausExplicit=explicit&&typeof explicit.binary==='string'&&Array.isArray(explicit.args)&&explicit.args.length<=20&&explicit.args.every(a=>typeof a==='string'&&a.length<=1000)
   ?(isNoOp(explicit.binary,explicit.args)?{invalid:`villaforge.verify.json: "${[explicit.binary,...explicit.args].join(' ').slice(0,90)}" ist ein Platzhalter und zaehlt nicht als Nachweis`}:explicit)
   :null;
  const gueltig=[ausPkg,ausExplicit].find(k=>k&&!k.invalid);
  if(gueltig)return [kind,gueltig];
  const abgelehnt=[ausPkg,ausExplicit].find(k=>k&&k.invalid);
  if(abgelehnt)return [kind,abgelehnt];
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
   if(plan[kind]?.invalid){checks[kind]={status:'missing',reason:plan[kind].invalid};blockers.push(`${kind}: ${plan[kind].invalid}`);continue;}
   if(!plan[kind]){checks[kind]={status:'missing',reason:'Prüfbefehl fehlt (package.json oder villaforge.verify.json)'};blockers.push(`${kind}: Prüfbefehl fehlt (package.json oder villaforge.verify.json)`);continue;}
   const {binary,args}=plan[kind];let result;
   try{result=await runner(project.root,binary,args,180000);}catch{result={ok:false,error:'Prüfprozess nicht ausführbar'};}
   checks[kind]={status:result.ok?'passed':'failed',command:[binary,...args],...(result.artifacts?{artifacts:result.artifacts}:{}),output:String(result.output||result.error||'').slice(-2000)};
   if(!result.ok)blockers.push(`${kind}: fehlgeschlagen`);
  }
  const htmlPath=join(project.root,'index.html');
  if(existsSync(htmlPath)){
   let html='';try{html=readFileSync(htmlPath,'utf8');}catch{}
   if(/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i.test(html)){
    const quality=calculateQualityGate({
     syntax:checks.build?.status==='passed'?100:0,
     tests:checks.tests?.status==='passed'?100:0,
     security:scoreStandaloneHtmlSecurity(html),
     performance:scoreStandaloneHtmlPerformance(Buffer.byteLength(html,'utf8'))
    },90);
    checks.quality={status:quality.passed?'passed':'failed',...quality};
    if(!quality.passed)blockers.push(`quality: standalone HTML score ${quality.score}/100 is below ${quality.threshold}; syntax ${quality.syntax}, tests ${quality.tests}, security ${quality.security}, performance ${quality.performance}`);
   }
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
