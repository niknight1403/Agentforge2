import { db, now } from './db.mjs';
import { deliveryReadiness } from './delivery-quality.mjs';

export const ULTRA_VERSION = '1.0.0';
export const QUALITY_GATE = 85;
export const PERMISSION_LEVELS = Object.freeze({
  READ:0, SANDBOX:1, PROJECT_WRITE:2, INFRASTRUCTURE:3, EXTERNAL_EFFECT:4
});

export const CAPABILITIES = Object.freeze([
  {id:'orchestration',agent:'APEX-ORCHESTRATOR',level:1},
  {id:'autopilot',agent:'AUTOPILOT',level:2},
  {id:'programming',agent:'PROGRAMMER',level:2},
  {id:'architecture',agent:'ARCHITECT',level:2},
  {id:'debugging',agent:'DEBUGGER',level:2},
  {id:'testing',agent:'TESTER',level:2},
  {id:'security',agent:'SECURITY',level:2,note:'Defensiv und nur fuer eigene/ausdruecklich autorisierte Systeme.'},
  {id:'business',agent:'MONEY-EXPERT',level:1},
  {id:'growth',agent:'GROWTH',level:1},
  {id:'design',agent:'DESIGNER',level:2},
  {id:'research',agent:'RESEARCHER',level:1},
  {id:'multitalent',agent:'MULTI-TALENT',level:2},
  {id:'tool_factory',agent:'TOOL-BUILDER',level:2},
  {id:'agent_factory',agent:'AGENT-FACTORY',level:2},
  {id:'route_brain',agent:'LLM-ROUTER',level:1},
  {id:'critic',agent:'CRITIC',level:1},
  {id:'verification',agent:'VERIFIER',level:1},
  {id:'evolution',agent:'SYNTHESIZER',level:1}
]);

db.exec(`
CREATE TABLE IF NOT EXISTS ultra_state (
  villa_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  cycle INTEGER NOT NULL DEFAULT 0,
  quality_score INTEGER NOT NULL DEFAULT 0,
  last_decision TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ultra_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  villa_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ultra_lessons_villa ON ultra_lessons(villa_id, created_at);
`);

function clamp(n, lo=0, hi=100) { return Math.max(lo,Math.min(hi,Number(n)||0)); }
function villa(villaId) {
  const row=db.prepare('SELECT id,name,status,autonomy FROM villas WHERE id=?').get(Number(villaId));
  if (!row) throw new Error('Villa nicht gefunden.');
  return row;
}
function metrics(villaId) {
  const rows=db.prepare("SELECT status,COUNT(*) c FROM tasks WHERE villa_id=? GROUP BY status").all(villaId);
  const m=Object.fromEntries(rows.map(r=>[r.status,Number(r.c)]));
  const total=rows.reduce((s,r)=>s+Number(r.c),0);
  const done=m.DONE||0, failed=m.FAILED||0, open=(m.PENDING||0)+(m.READY||0)+(m.RUNNING||0)+(m.REVIEW||0);
  const verified=db.prepare("SELECT COUNT(*) c FROM memories WHERE villa_id=? AND kind IN ('LESSON','DECISION','ARTIFACT')").get(villaId).c;
  const rawScore=total ? clamp(Math.round((done/total)*75 + Math.min(15,verified*3) - failed*8 + (open===0&&done>0?10:0))) : 0;
  const readiness=deliveryReadiness(Number(villaId));
  const score=readiness.verified && open===0 && failed===0 ? Math.max(90,rawScore) : Math.min(84,rawScore);
  return {total,done,failed,open,verified:Number(verified),score,readiness};
}
export function qualityScore(villaId) { villa(villaId); return metrics(Number(villaId)).score; }

export function ultraStatus(villaId) {
  const v=villa(villaId), m=metrics(v.id);
  const state=db.prepare('SELECT * FROM ultra_state WHERE villa_id=?').get(v.id);
  const routes=db.prepare('SELECT COUNT(*) c FROM routes WHERE enabled=1').get().c;
  const lessons=db.prepare('SELECT COUNT(*) c FROM ultra_lessons WHERE villa_id=?').get(v.id).c;
  return {
    version:ULTRA_VERSION,villa:v,enabled:!!state?.enabled,cycle:Number(state?.cycle||0),
    qualityScore:m.score,qualityGate:QUALITY_GATE,gatePassed:m.score>=QUALITY_GATE && m.readiness.verified && m.open===0 && m.failed===0,
    delivery:{domain:m.readiness.domain,label:m.readiness.label,verified:m.readiness.verified,blockers:m.readiness.blockers,artifacts:m.readiness.artifacts?.length||0},
    tasks:m,activeRoutes:Number(routes),lessons:Number(lessons),
    capabilities:CAPABILITIES,lastDecision:state?.last_decision||'',lastError:state?.last_error||''
  };
}

export function evaluateNextAction(villaId) {
  const s=ultraStatus(villaId);
  if (!s.enabled) return {action:'PAUSED',reason:'Ultra-Autopilot ist deaktiviert.'};
  if (s.tasks.failed>0) return {action:'HEAL',reason:'Fehlgeschlagene Aufgaben zuerst reparieren.'};
  if (s.tasks.open>0) return {action:'EXECUTE',reason:'Offene Aufgaben weiter ausfuehren.'};
  if (s.tasks.done===0) return {action:'PLAN',reason:'Noch keine verifizierte Umsetzung vorhanden.'};
  if (!s.gatePassed && s.tasks.open===0 && s.tasks.readiness.blockers?.length) return {action:'IMPROVE',reason:s.tasks.readiness.blockers[0]};
  if (!s.gatePassed) return {action:'IMPROVE',reason:`Quality Gate ${QUALITY_GATE} noch nicht erreicht.`};
  return {action:'VERIFY_RELEASE',reason:'Quality Gate erreicht; Release-Verifikation ausfuehren.'};
}

export function recordLesson(villaId,{kind='LESSON',content,score=0}={}) {
  villa(villaId);
  const value=String(content||'').trim();
  if (!value) throw new Error('Lesson darf nicht leer sein.');
  db.prepare('INSERT INTO ultra_lessons(villa_id,kind,content,score,created_at) VALUES (?,?,?,?,?)')
    .run(Number(villaId),String(kind).slice(0,32),value.slice(0,8000),clamp(score),now());
  return {ok:true};
}

export function createUltraAgent({isRunning=()=>false,startVilla=async()=>({started:false}),stopVilla=()=>false}={}) {
  function setEnabled(villaId,enabled) {
    const v=villa(villaId), ts=now();
    db.prepare(`INSERT INTO ultra_state(villa_id,enabled,cycle,quality_score,last_decision,last_error,updated_at)
      VALUES (?,?,0,0,'','',?)
      ON CONFLICT(villa_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(v.id,Number(!!enabled),ts);
    db.prepare('UPDATE villas SET autonomy=?,updated_at=? WHERE id=?').run(Number(!!enabled),ts,v.id);
    if (!enabled && isRunning(v.id)) stopVilla(v.id);
    return ultraStatus(v.id);
  }
  async function tick(villaId) {
    const s=ultraStatus(villaId);
    if (!s.enabled) return {...s,decision:evaluateNextAction(villaId),started:false};
    const decision=evaluateNextAction(villaId);
    let started=false,error='';
    try {
      if (['HEAL','EXECUTE','PLAN','IMPROVE','VERIFY_RELEASE'].includes(decision.action) && !isRunning(Number(villaId))) {
        await startVilla(Number(villaId)); started=true;
      }
    } catch (e) { error=String(e?.message||e); }
    const score=qualityScore(villaId);
    db.prepare('UPDATE ultra_state SET cycle=cycle+1,quality_score=?,last_decision=?,last_error=?,updated_at=? WHERE villa_id=?')
      .run(score,decision.action,error,now(),Number(villaId));
    db.prepare('INSERT INTO audit(ts,villa_id,tool,args,result,allowed) VALUES (?,?,?,?,?,1)')
      .run(now(),Number(villaId),'ultra:tick',JSON.stringify({decision}),JSON.stringify({started,error,score}));
    return {...ultraStatus(villaId),decision,started,error};
  }
  return {status:ultraStatus,setEnabled,tick,recordLesson};
}
