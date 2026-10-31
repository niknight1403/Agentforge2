import { forgeLog } from './keyforge.mjs';
import { db, now } from './db.mjs';
import { freeOnlyEnabled,isFreeRoute,KEY_ALIASES,isLocalRoute } from './llm-config.mjs';
import { createCascade, orderCascadeRoutes } from './llm-cascade.mjs';
import { createRequestLimiter } from './request-limiter.mjs';
import { createCircuitBreaker } from './circuit-breaker.mjs';
import { userStore, quotaLeft, chargeTokens } from './auth.mjs';
import { emit } from './events.mjs';
import { tokenBudgetStatus, recordLlmUsage } from './observability.mjs';
import { createHash } from 'node:crypto';

/** Liefert einen Key aus Secrets-Store oder Umgebung. */
export function resolveKey(keyEnv) {
  if (!keyEnv) return '';
  for (const name of [keyEnv,...(KEY_ALIASES[keyEnv]||[])]) {
    const value=db.prepare('SELECT value FROM secrets WHERE name=?').get(name)?.value || process.env[name];
    if(value) return value;
  }
  return '';
}

export function keyStatus() {
  const rows = db.prepare('SELECT name FROM secrets').all().map((r) => r.name);
  return { stored: rows };
}

export function enabledRoutes() {
  return db.prepare('SELECT * FROM routes WHERE enabled = 1 ORDER BY priority ASC, COALESCE(lat_ms, 5000) ASC, id ASC').all();
}

/** Waehlt die naechste Route: Prioritaet, dann gewichtete Rotation. */
export function pickRoute() {
  return enabledRoutes().filter(r=>r.provider!=='offline' && (!freeOnlyEnabled()||isFreeRoute(r)) && isUsable(r))[0] || null;
}

/* GATEWAY-Metriken (Charta 2026-10-18): Latenz (EMA) und Token-Verbrauch je Route. */
try { db.exec('ALTER TABLE routes ADD COLUMN lat_ms INTEGER'); } catch { /* Spalte existiert */ }
try { db.exec('ALTER TABLE routes ADD COLUMN tokens INTEGER'); } catch { /* Spalte existiert */ }

function recordRoute(id, ok, latMs = 0, tok = 0) {
  if (!id) return;
  /* Adaptive Routen-Intelligenz: Erfolg laesst das Gewicht wachsen (bis 2x),
     Fehler schrumpfen es (bis 0.2x). Der Score-Sortierer bevorzugt Routen
     mit hohem Gewicht und niedriger Fehlquote statt starrer Prioritaet. */
  const r = db.prepare('SELECT weight FROM routes WHERE id = ?').get(id);
  const w = Math.min(2, Math.max(0.2, (Number(r?.weight) || 1) * (ok ? 1.1 : 0.7)));
  const row = db.prepare('SELECT lat_ms, tokens FROM routes WHERE id = ?').get(id) || {};
  const emaLat = latMs > 0 ? Math.round(0.3 * latMs + 0.7 * (Number(row.lat_ms) || latMs)) : (Number(row.lat_ms) || 0);
  db.prepare(
    'UPDATE routes SET status = ?, ok = ok + ?, fail = fail + ?, last_used = ?, weight = ?, lat_ms = ?, tokens = ? WHERE id = ?'
  ).run(ok ? 'OK' : 'ERROR', ok ? 1 : 0, ok ? 0 : 1, now(), Math.round(w * 100) / 100, emaLat, Number(row.tokens || 0) + tok, id);
}

/**
 * Legt eine fehlgeschlagene Route voruebergehend still.
 * Nach mehreren Fehlern waechst die Sperrzeit, damit der Rotator nicht bei
 * jedem Aufruf erneut in dieselbe tote Route laeuft.
 */
function coolDown(route,error) {
 if (!route.id || error.busy) return;
 const status=Number(error.status)||0;
 const retry=Number(error.retryAfterMs)||0;
 const ms=[401,403].includes(status)?300000:status===429?Math.max(120000,Math.min(retry,600000)):15000;
 /* Kadaver-Routen: viele Fehlversuche und null Erfolge belegen dauerhaft
    fehlende Erreichbarkeit - stilllegen statt bei jedem Aufruf erneut testen. */
 try{const st=db.prepare('SELECT ok,fail FROM routes WHERE id=?').get(route.id);if(st&&Number(st.fail)>=50&&Number(st.ok)===0)db.prepare("UPDATE routes SET enabled=0,status='DEAD' WHERE id=?").run(route.id);}catch{}
 db.prepare('UPDATE routes SET cooldown_until=? WHERE id=?').run(Math.max(now()+ms,Number(route.cooldown_until)||0),route.id);
}

/** Routen, die gerade nicht gesperrt sind. */
function isUsable(route) {
  if (route.provider === 'offline') return false;
  if (Number(route.cooldown_until || 0) > now()) return false;
  // Key-lose Routen (z.B. lokales Ollama) sind offen und immer benutzbar.
  if (!route.key_env) return true;
  return !!resolveKey(route.key_env);
}

/**
 * Selbst gehostetes Ollama (ARM-CPU, 4 Kerne) schafft nur wenige gleichzeitige
 * Anfragen. Ohne Grenze fallen bei erschoepften Cloud-Kontingenten ALLE Villen
 * gleichzeitig auf Ollama durch, die CPU ueberlaeuft und jede Anfrage rennt in
 * den Timeout (Hub-Last > 10, Antworten > 5 Min). Deshalb: globale Schlange.
 */
const OLLAMA_MAX_PARALLEL = Math.max(1, Number(process.env.OLLAMA_MAX_PARALLEL) || 1);
const OLLAMA_MAX_QUEUE = Math.max(1, Number(process.env.OLLAMA_MAX_QUEUE) || 4);
let ollamaActive = 0;
const ollamaWaiters = [];

async function acquireOllama() {
  if (ollamaActive < OLLAMA_MAX_PARALLEL) { ollamaActive++; return; }
  // Warteschlange voll: sofort ablehnen, damit der Router die naechste Route nimmt
  // (oder die Aufgabe spaeter erneut versucht) statt die CPU weiter zu belasten.
  if (ollamaWaiters.length >= OLLAMA_MAX_QUEUE) {
    const err = new Error('Ollama ausgelastet (Warteschlange voll)');
    err.busy = true; // Ueberlast ist kein Routenfehler: keine Sperre, kein Fehlerzaehler
    throw err;
  }
  // Gebundenes Warten: ohnehin abgelehnt/uebernommen spaetestens nach 30 s.
  // Frueher warteten Waiter EWIG - ein undichter Slot haengt dann ganze
  // Aufgaben-Batches fuer Stunden fest (Zombie-RUNNING-Aufgaben).
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const i = ollamaWaiters.indexOf(done);
      if (i >= 0) ollamaWaiters.splice(i, 1);
      const err = new Error('Ollama ausgelastet (Wartezeit abgelaufen)');
      err.busy = true;
      reject(err);
    }, 30_000);
    ollamaWaiters.push(done);
  });
}

function releaseOllama() {
  const next = ollamaWaiters.shift();
  if (next) next(); // Platz geht direkt an den naechsten Wartenden
  else ollamaActive = Math.max(0, ollamaActive - 1);
}

export const _ollamaQueue = { acquire: () => acquireOllama(), release: () => releaseOllama() };

export function ollamaQueueStats() {
  return { active: ollamaActive, waiting: ollamaWaiters.length, maxParallel: OLLAMA_MAX_PARALLEL, maxQueue: OLLAMA_MAX_QUEUE };
}

/**
 * Pro-Route-Ratenbegrenzung: Free-Tier-APIs (Gemini, Groq) sperren bei
 * Anfrage-Sturzbett mit 429 - danach rutschen ALLE Routen in den Cooldown und
 * der Offline-Planer uebernimmt. Ein lokaler Token-Bucket haelt das Volumen
 * VOR dem API-Limit, damit die Kette stabil erreichbar bleibt.
 */
const requestLimiter=createRequestLimiter();
function routeRpm(route) {
  const n = String(route.name || '').toLowerCase();
  if (n.includes('gemini')) return Number(process.env.VF_RPM_GEMINI) || 8;   // Free-Tier ~10 RPM
  if (n.includes('groq')) return Number(process.env.VF_RPM_GROQ) || 20;
  if (n.includes('cerebras')) return Number(process.env.VF_RPM_CEREBRAS) || 10;
  if (n.includes('mistral')) return Number(process.env.VF_RPM_MISTRAL) || 5;
  if (n.includes('openrouter')) return Number(process.env.VF_RPM_OPENROUTER) || 12;
  return Number(process.env.VF_RPM_DEFAULT) || 30;
}

const providerCircuits=createCircuitBreaker({
 failureThreshold:Math.max(1,Number(process.env.VF_LLM_CIRCUIT_FAILURES)||3),
 resetAfterMs:Math.max(1000,Number(process.env.VF_LLM_CIRCUIT_RESET_MS)||30000)
});

function providerCircuitKey(route) {
 let host;try{host=new URL(route.base_url).host;}catch{host=String(route.provider||'unknown');}
 const credential=resolveKey(route.key_env);
 // Keep each configured credential's quota isolated; aliases with the same
 // value still share a circuit. No credential or fingerprint is exposed.
 return host+'|'+(credential?createHash('sha256').update(credential).digest('hex'):'public');
}

async function callOpenAiCompatible(route, messages, opts) {
  return providerCircuits.execute(providerCircuitKey(route),()=>{
    if(!isLocalRoute(route)){
      const permit=requestLimiter.admit(providerCircuitKey(route),routeRpm(route),{interactive:opts.priority==='interactive'});
      if(!permit.ok)throw Object.assign(new Error('Provider request window is busy.'),{busy:true,code:'RATE_WINDOW_BUSY',retryAfterMs:permit.retryAfterMs});
    }
    return callOpenAiCompatibleRaw(route,messages,opts);
  });
}

const localModels=new Map();
async function callOpenAiCompatibleRaw(route, messages, opts) {
  const requestSignal=opts.signal?AbortSignal.any([opts.signal,AbortSignal.timeout(opts.timeoutMs??(Number(process.env.VF_LLM_TIMEOUT_MS)||15000))]):AbortSignal.timeout(opts.timeoutMs??15000);
  const key = resolveKey(route.key_env);
  const headers = { 'Content-Type': 'application/json' };
  // Fal.ai authentifiziert mit "Key" statt "Bearer": provider-abhaengig setzen.
  if (key) headers['Authorization'] = route.provider === 'fal' ? `Key ${key}` : `Bearer ${key}`;
  let selectedModel=route.model;
  if(selectedModel==='auto') {
    const found=localModels.get(route.base_url);
    if(found && found.until>Date.now()) selectedModel=found.id;
    else {
      const discoveryTimeout=AbortSignal.timeout(Math.min(opts.timeoutMs,1500));
      const models=await fetch(`${route.base_url.replace(/\/$/,'')}/models`,{headers,signal:AbortSignal.any([requestSignal,discoveryTimeout])});
      if(!models.ok)throw Object.assign(new Error('Local model discovery failed'),{status:models.status});
      const data=await models.json();
      const list=(data.data||[]).filter(m=>typeof m.id==='string');
      const preferred=route.provider==='gemini'?list.find(m=>/gemini.*flash/i.test(m.id)&&!/image|tts|audio/i.test(m.id)):list[0];
      selectedModel=preferred?.id;
      if(route.provider==='gemini')selectedModel=selectedModel?.replace(/^models\//,'');
      if(!selectedModel)throw Object.assign(new Error('No local model loaded'),{code:'NO_LOCAL_MODEL'});
      localModels.set(route.base_url,{id:selectedModel,until:Date.now()+60000});
    }
  }
  const body = {
    model: selectedModel,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 2048
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  /* Ollama: Modell im Speicher halten (keep_alive=-1). Ohne das kostet jeder
     Aufruf auf einem Remote-Knoten 10-30s Modell-Ladezeit. */
  if (String(route.base_url || '').includes(':11434')) body.keep_alive = -1;

  const res = await fetch(`${route.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: requestSignal
  });
  if (!res.ok) {
    await res.body?.cancel().catch(()=>{});
    const retry=res.headers.get('retry-after');
    const retryAfterMs=retry ? (/^\d+$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())) : 0;
    throw Object.assign(new Error(`Provider HTTP ${res.status}`),{status:res.status,retryAfterMs});
  }
  const data = await res.json();
  const choice = data.choices?.[0] ?? {};
  const content = String(choice.message?.content ?? '').trim();
  /* Leere Antworten sind Routenfehler: Failover auf die naechste Route
     statt einer scheinbar erfolgreichen, inhaltsleeren Rueckgabe. */
  if (!content) throw new Error('Route lieferte eine leere Antwort');
  return {
    content,
    model: data.model ?? route.model,
    route: route.name,
    usage: data.usage ?? null
  };
}

/** Regelbasierter Planer, der ohne LLM eine sinnvolle Aufgabenliste erzeugt. */
export function derivePlan(idea, agentCount = 12) {
  const clean = String(idea || 'Idee')
    .split('\n')[0]
    .replace(/^Idee:\s*/i, '')
    .trim()
    .slice(0, 160) || 'Idee';
  const base = [
    { role: 'PLANNER', title: 'Anforderungen & Erfolgskriterien', description: `Ziele, Scope und messbare Kriterien fuer: ${clean}` },
    { role: 'RESEARCHER', title: 'Markt- und Technikrecherche', description: 'Wettbewerb, vergleichbare Loesungen, verfuegbare Technologien und kostenlose Bausteine sammeln.' },
    { role: 'ARCHITECT', title: 'Architektur & Datenmodell', description: 'Komponenten, Schnittstellen, Datenhaltung und Deployment skizzieren.' },
    { role: 'CODER', title: 'Kernfunktion implementieren', description: 'Wichtigsten Nutzerfluss als lauffaehigen Prototyp umsetzen.' },
    { role: 'CODER', title: 'Schnittstellen & Integration', description: 'Externe APIs, Speicher und Konfiguration anbinden.' },
    { role: 'REVIEWER', title: 'Code-Review & Qualitaet', description: 'Lesbarkeit, Fehlerbehandlung, Sicherheit pruefen.' },
    { role: 'TESTER', title: 'Tests & Fehlerfaelle', description: 'Automatisierte Tests und manuelle Randfaelle.' },
    { role: 'DOCUMENTER', title: 'Dokumentation', description: 'README, Nutzung und Betrieb dokumentieren.' },
    { role: 'CRITIC', title: 'Risiko- und Lueckenanalyse', description: 'Was fehlt, was bricht, was ist unklar.' },
    { role: 'BUSINESS', title: 'Geschaeftsmodell und Umsatzquellen', description: 'Zahlende Zielgruppe, Preismodell, Kosten und Marge mit konkreten Annahmen.' },
    { role: 'GROWTH', title: 'Wachstums- und Vertriebsplan', description: 'Akquise-Kanaele, Aktivierung, Bindung und Messgroessen fuer 90 Tage.' },
    { role: 'INTEGRATOR', title: 'Zusammenfuehren & Release', description: 'Teilergebnisse buendeln und Release-Kandidat bauen.' }
  ];
  return {
    summary: `Plan fuer "${clean}"`,
    agents: Math.max(3, Math.min(agentCount, 1000)),
    tasks: base
  };
}

/** Verbrauchte Tokens: echte usage bevorzugen, sonst aus Textlaenge schaetzen. */
function usageTokens(messages, out) {
  const u = out?.usage;
  if (u && (u.total_tokens || (u.prompt_tokens + u.completion_tokens))) {
    return u.total_tokens || (u.prompt_tokens + u.completion_tokens);
  }
  const inChars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
  const outChars = String(out?.content || '').length;
  return Math.ceil((inChars + outChars) / 4);
}

/** Rollen, die die staerkste Route bekommen (FALLBACK statt Rotation). */
export const QUALITY_ROLES = new Set(['ROOT', 'CODER', 'ARCHITECT', 'REVIEWER', 'INTEGRATOR']);

/**
 * Chat-Aufruf mit Rotation und Failover ueber alle aktiven Routen.
 * Rollen aus QUALITY_ROLES laufen mit FALLBACK: die Route mit hoechster
 * Prioritaet (bestes Modell) zuerst, damit Code- und Architekturarbeit
 * immer mit der verfuegbaren Top-Qualitaet arbeitet.
 */

/* VForge-Router (Charta 2026-10-18): Route-Wechsel praezise protokollieren,
   aber gedrosselt - Sturm-Phasen erzeugen tausend Failover pro Minute. */
const switchLogged = new Map();
const SWITCH_THROTTLE_MS = 5 * 60_000;
function logRouteSwitch(failedName, successName, reason) {
  const key = failedName + '->' + successName;
  if (Date.now() - (switchLogged.get(key) || 0) < SWITCH_THROTTLE_MS) return;
  switchLogged.set(key, Date.now());
  try { forgeLog('routeforge:switch', `Route SWITCHED: ${failedName} -> ${successName} [Reason: ${String(reason).slice(0, 120)}]`); } catch { /* Log darf den Takt nie brechen */ }
}

const routesWithinBudget=()=>{const all=enabledRoutes(),budget=tokenBudgetStatus();return budget.paidRoutesAllowed?all:all.filter(isFreeRoute);};
const cascade=createCascade({
 routes:routesWithinBudget,key:resolveKey,call:callOpenAiCompatible,
 success(route,out,latency){recordRoute(route.id,true,latency,usageTokens([],out));},
 failure(route,error){if(!error.busy){recordRoute(route.id,false);coolDown(route,error);}}
});
export async function chat(messages,opts={}) {
 const user=userStore.getStore();
 if(user && quotaLeft(user)<=0) throw new Error('QUOTA_EXCEEDED: Tageskontingent aufgebraucht.');
 const tokenBudget=tokenBudgetStatus();
 /* Bezahlte Routen sind bei erschoepftem Budget gesperrt - kostenlose
    Routen und selbst gehostete Knoten laufen weiter. Nur wenn es gar
    keine freie Route gibt, ist der Kill-Switch wirklich aktiv. */
 if(!tokenBudget.tokenAllowed && !enabledRoutes().some(r=>r.provider!=='offline'&&isFreeRoute(r))) throw Object.assign(new Error('QUOTA_EXCEEDED: Globales Tages-Tokenbudget erreicht; Kill-Switch aktiv.'),{code:'GLOBAL_TOKEN_BUDGET',statusCode:429,retryAfter:Math.max(1,Math.ceil((tokenBudget.resetsAt-Date.now())/1000)),resetsAt:tokenBudget.resetsAt});
 const started=Date.now();
 try {
  const out=await cascade(messages,opts);
  const route=enabledRoutes().find(item=>item.name===out.route);
  const tokens=usageTokens(messages,out), durationMs=Date.now()-started;
  const budget=recordLlmUsage({tokens,provider:route?.provider||'unknown',model:String(out.model||route?.model||'unknown'),latencyMs:durationMs,isFree:!!route&&isFreeRoute(route)});
  emit('llm',{durationMs,tokensUsed:tokens,provider:route?.provider||'unknown',model:String(out.model||route?.model||'unknown').slice(0,120),route:String(out.route||'unknown').slice(0,120),budget});
  if(user)chargeTokens(user.id,tokens);
  return out;
 } catch(error) {
  emit('llm.failed',{durationMs:Date.now()-started,code:String(error?.code||error?.status||'LLM_ERROR').slice(0,80)});
  throw error;
 }
}
export function routingStatus() {
  const freeOnly=freeOnlyEnabled();
  const enabled=enabledRoutes().filter(r=>r.provider!=='offline');
  const routes=enabled.map(r=>{
    const circuit=providerCircuits.snapshot(providerCircuitKey(r));
    const configured=!r.key_env||!!resolveKey(r.key_env);
    const eligible=(!freeOnly||isFreeRoute(r))&&configured&&Number(r.cooldown_until||0)<=Date.now()&&(circuit.state!=='OPEN'||circuit.retryAt<=Date.now());
    return {id:r.id,name:r.name,model:r.model,provider:r.provider,priority:r.priority,isFree:isFreeRoute(r),local:isLocalRoute(r),configured,eligible,cooldownUntil:r.cooldown_until||0,status:r.status,circuit:{state:circuit.state,retryAt:circuit.retryAt}};
  });
  const eligibleIds=new Set(routes.filter(r=>r.eligible).map(r=>r.id));
  const candidates=enabled.filter(r=>eligibleIds.has(r.id));
  const names=(ordered)=>ordered.map((r,index)=>({position:index+1,id:r.id,name:r.name,model:r.model,provider:r.provider,local:isLocalRoute(r),free:isFreeRoute(r)}));
  return {mode:'cascade',ruleBasedFallback:false,freeOnly,policy:{routine:'LOCAL_FIRST',complex:'QUALITY_FALLBACK',offlinePlan:'disabled'},routes,routineChain:names(orderCascadeRoutes(candidates,{strategy:'LOCAL_FIRST',freeOnlyMode:freeOnly})),qualityChain:names(orderCascadeRoutes(candidates,{role:'CODER',freeOnlyMode:freeOnly}))};
}

export function routingSummary(){
 const status=routingStatus();
 const routes=status.routes;
 const eligible=routes.filter(r=>r.eligible).length;
 const latestRoute=db.prepare("SELECT last_used,name,provider,model,base_url FROM routes WHERE provider!='offline' AND status='OK' ORDER BY last_used DESC").all().find(r=>!status.freeOnly||isFreeRoute(r));
 const latest=latestRoute?.last_used||0;
 return {mode:'cascade',ruleBasedFallback:false,queue:cascade.stats(),freeOnly:status.freeOnly,configuredRoutes:routes.filter(r=>r.configured).length,eligibleRoutes:eligible,lastSuccessfulReplyAt:latest||null,lastSuccessfulRoute:latestRoute?.name||null,state:latest&&Date.now()-latest<300000?'recently_verified':eligible?'unverified':'unavailable'};
}
