import { db, now } from './db.mjs';
import { OFFLINE_ROUTE } from './routes.mjs';

/** Liefert einen Key aus Secrets-Store oder Umgebung. */
export function resolveKey(keyEnv) {
  if (!keyEnv) return '';
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(keyEnv);
  if (row && row.value) return row.value;
  return process.env[keyEnv] || '';
}

/**
 * Key-Pool eines Namens: Basiswert zuerst, dann nummerierte Zweit-Keys
 * (_2 bis _12), Store vor Umgebung. Rotation bei erschöpftem Kontingent.
 */
export function resolveKeys(keyEnv) {
  if (!keyEnv) return [];
  const names = [keyEnv, ...Array.from({ length: 11 }, (_, i) => `${keyEnv}_${i + 2}`)];
  const out = [];
  for (const name of names) {
    const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name);
    const value = (row && row.value) || process.env[name] || '';
    if (value) out.push({ name, value });
  }
  return out;
}

/** Ist ein einzelner Key gerade im Kontingent-Kuehlzustand? */
export function isKeyCooling(name) {
  if (!name) return false;
  const row = db.prepare('SELECT until FROM key_cool WHERE name = ?').get(name);
  return !!row && Number(row.until) > Date.now();
}

/** Legt einen Key nach 429/402 kurz still (gleiche Kurve wie Routen). */
export function coolKey(name, ms = 45_000) {
  if (!name) return;
  db.prepare('INSERT INTO key_cool (name, until) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET until = excluded.until')
    .run(name, now() + ms);
}

/** Sichtbarkeit: welche Key-Pools existieren und wie viele sind einsatzbereit. Nur Namen, nie Werte. */
export function keyPools() {
  const seen = new Set();
  const pools = [];
  for (const r of enabledRoutes()) {
    if (!r.key_env || seen.has(r.key_env)) continue;
    const keys = resolveKeys(r.key_env);
    if (!keys.length) continue;
    seen.add(r.key_env);
    pools.push({ env: r.key_env, keys: keys.map((k) => k.name), ready: keys.filter((k) => !isKeyCooling(k.name)).length });
  }
  return pools;
}

export function keyStatus() {
  const rows = db.prepare('SELECT name FROM secrets').all().map((r) => r.name);
  return { stored: rows };
}

export function enabledRoutes() {
  return db.prepare('SELECT * FROM routes WHERE enabled = 1 ORDER BY priority ASC, id ASC').all();
}

/** Waehlt die naechste Route: Prioritaet, dann gewichtete Rotation. */
export function pickRoute(strategy = 'ROTATE') {
  // Nur Routen, die wirklich genutzt werden koennen: Offline immer, lokale
  // Routen ohne Key-Pflicht ebenfalls, fremde nur mit hinterlegtem Key.
  const usable = enabledRoutes().filter(isUsable);
  if (!usable.length) return { ...OFFLINE_ROUTE, id: 0, provider: 'offline' };
  const pool = usable;

  if (strategy === 'FALLBACK') return pool[0];

  // ROTATE: die am laengsten ungenutzte Route mit bester Prioritaet zuerst.
  const sorted = [...pool].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.last_used || 0) - (b.last_used || 0);
  });
  return sorted[0];
}

function recordRoute(id, ok) {
  if (!id) return;
  db.prepare(
    'UPDATE routes SET status = ?, ok = ok + ?, fail = fail + ?, last_used = ? WHERE id = ?'
  ).run(ok ? 'OK' : 'ERROR', ok ? 1 : 0, ok ? 0 : 1, now(), id);
}

/**
 * Legt eine fehlgeschlagene Route voruebergehend still.
 * Nach mehreren Fehlern waechst die Sperrzeit, damit der Rotator nicht bei
 * jedem Aufruf erneut in dieselbe tote Route laeuft.
 */
const COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 45_000;
function coolDown(route, rateLimited = false) {
  if (!route.id) return;
  // 429 heisst "gleich wieder", nicht "kaputt": kurze Pause ohne Eskalation,
  // damit ein Gratis-Tageslimit den Lauf nicht fuer Minuten lahmlegt.
  if (rateLimited) {
    db.prepare('UPDATE routes SET cooldown_until = ? WHERE id = ?').run(now() + RATE_LIMIT_COOLDOWN_MS, route.id);
    return;
  }
  const fails = Number(route.fail || 0) + 1;
  const until = now() + Math.min(COOLDOWN_MS * fails, 10 * 60_000);
  db.prepare('UPDATE routes SET cooldown_until = ? WHERE id = ?').run(until, route.id);
}

/**
 * Anzahl gerade nutzbarer ECHTER Routen (ohne Offline-Planer).
 * Massstab fuer die adaptive Parallelitaet: wenn nur noch eine Route
 * aus dem Cooldown kommt, bringen vier parallele Agenten nur 429er.
 */
export function readyRealRoutes() {
  const usable = enabledRoutes().filter(isUsable);
  return usable.filter((r) => r.provider !== 'offline' && r.priority < 50).length;
}

/**
 * Routen, die gerade nutzbar sind: nicht gesperrt und mit Key versorgt.
 * Routen ohne key_env (z. B. ein lokaler Ollama) brauchen keinen Key.
 */
export function isUsable(route) {
  if (route.provider === 'offline') return true;
  if (Number(route.cooldown_until || 0) > now()) return false;
  if (!route.key_env) return true;
  return !!resolveKey(route.key_env);
}

async function callOpenAiCompatible(route, messages, opts) {
  // Key-Pool: bei erschöpftem Kontingent (429/402) rotiert der Aufruf auf den
  // nächsten hinterlegten Key derselben Route, bevor die Route kippt.
  const keys = route.key_env ? resolveKeys(route.key_env) : [{ name: '', value: '' }];
  const ready = keys.filter((k) => !isKeyCooling(k.name));
  const order = ready.length ? ready : keys;
  let quotaErr = null;
  for (const k of order) {
    const out = await fetchOnce(route, k, messages, opts);
    if (out.ok) return out.data;
    if ((out.status === 429 || out.status === 402) && k.name) {
      coolKey(k.name);
      quotaErr = out.err;
      continue;
    }
    throw out.err;
  }
  throw quotaErr || new Error(`Route ${route.name}: kein verwendbarer Key`);
}

/** Ein einzelner Anruf mit genau einem Key. */
async function fetchOnce(route, k, messages, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (k.value) headers['Authorization'] = `Bearer ${k.value}`;
  const body = {
    model: route.model,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 2048
  };
  // JSON-Modus nur, wo er verlaesslich funktioniert. Groqs gpt-oss-Modelle
  // werfen im JSON-Modus haeufig HTTP 400 (json_validate_failed /
  // tool_use_failed) und blockieren damit den ganzen Lauf; der ReAct-Loop
  // parst die Antwort ohnehin selbst und wiederholt Nicht-JSON-Antworten.
  if (opts.json && !/gpt-oss/.test(route.model)) body.response_format = { type: 'json_object' };
  try {
    const res = await fetch(`${route.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      return { ok: false, status: res.status, err };
    }
    const data = await res.json();
    const choice = data.choices?.[0] ?? {};
    // Reasoning-Modelle (z. B. gpt-oss) koennen bei kleinem Budget nur
    // Gedankengang liefern: dann ist das besser als eine leere Antwort.
    const content = choice.message?.content || choice.message?.reasoning || '';
    return { ok: true, data: { content, model: data.model ?? route.model, route: route.name, usage: data.usage ?? null } };
  } catch (e) {
    return { ok: false, status: 0, err: e };
  }
}

function offlineReply(messages, opts) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const wrap = (content) => ({ content, model: OFFLINE_ROUTE.model, route: OFFLINE_ROUTE.name, offline: true });

  // Planungsmodus: regelbasierter Projektplan.
  if (opts.mode === 'plan') {
    return wrap(JSON.stringify(derivePlan(lastUser, opts.agentCount ?? 12)));
  }

  const answer = buildOfflineAnswer(lastUser, opts.context);
  // Agentenmodus: Antwort muss dem ReAct-Vertrag entsprechen.
  if (opts.mode === 'agent') return wrap(JSON.stringify({ final: answer }));
  return wrap(answer);
}

/** Baut eine gut lesbare, gegliederte Antwort im Markdown-Stil. */
function buildOfflineAnswer(question, context) {
  const clean = String(question || '').trim().replace(/\s+/g, ' ').slice(0, 300) || '(leer)';
  const lines = [];

  lines.push('## Zusammenfassung');
  lines.push('');
  lines.push(`Deine Nachricht: "${clean}"`);
  lines.push('');
  lines.push('Ich habe sie aufgenommen. Ein Sprachmodell ist gerade nicht angebunden, daher antworte ich mit dem regelbasierten Planer.');
  lines.push('');

  if (context) {
    lines.push('## Aktueller Stand');
    lines.push('');
    lines.push(context);
    lines.push('');
  }

  lines.push('## Empfohlene nächste Schritte');
  lines.push('');
  lines.push('1. Anforderungen und Erfolgskriterien schriftlich festhalten');
  lines.push('2. Architektur und Datenmodell skizzieren');
  lines.push('3. Umsetzung in kleine, prüfbare Teilaufgaben zerlegen');
  lines.push('4. Tests inklusive Randfälle beschreiben');
  lines.push('5. Ergebnis dokumentieren und ausliefern');
  lines.push('');

  lines.push('## Was du jetzt tun kannst');
  lines.push('');
  lines.push('- "Entwicklung starten" arbeitet alle offenen Aufgaben autonom ab und baut am Ende das Projekt');
  lines.push('- Unter Einstellungen einen Key hinterlegen (z. B. GROQ_API_KEY), damit ein Sprachmodell antwortet');

  return lines.join('\n');
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

/**
 * Chat-Aufruf mit Rotation und Failover ueber alle aktiven Routen.
 */
export async function chat(messages, opts = {}) {
  const routes = enabledRoutes();
  // Bewusster Offline-Betrieb (gar kein Zugang konfiguriert) ist ein
  // gewollter Zustand; Keys vorhanden, aber gerade im Limit, ist transient.
  // Nur echte Zaehler-Zugriffe (Keys) zaehlen als "konfiguriert": die
  // schluessellose Ollama-Route ist kein Nachweis, dass ein LLM existiert.
  const realConfigured = routes.some((r) => r.key_env && resolveKey(r.key_env));
  const strategy = opts.strategy || 'ROTATE';
  // Zuerst alle nutzbaren Routen. Ist keine mehr nutzbar (z. B. gerade im
  // Rate-Limit-Cooldown), werden Routen MIT Zugang erneut probiert, damit
  // ein Fenster vorbeiziehen kann; schluessellose Routen bleiben immer
  // dabei (lokale Verbindungen schlagen sofort fehl). Ohne jeden Zugang
  // geht es direkt zum Planer: bewusster Offline-Betrieb ohne 401er-Kette.
  let pool = routes.filter(isUsable);
  if (!pool.length) pool = routes.filter((r) => !r.key_env || resolveKey(r.key_env));
  const order = [];
  if (pool.length) {
    order.push(...[...pool].sort((a, b) => (strategy === 'ROTATE'
      ? (a.priority - b.priority) || ((a.last_used || 0) - (b.last_used || 0))
      : a.priority - b.priority)));
    order.push({ ...OFFLINE_ROUTE, id: 0 });
  } else {
    order.push({ ...OFFLINE_ROUTE, id: 0, intentional: true });
  }

  let lastErr = null;
  for (const route of order) {
    try {
      if (route.provider === 'offline') {
        const out = offlineReply(messages, opts);
        out.intentional = route.intentional !== undefined ? route.intentional : !realConfigured;
        // Auch der Offline-Rettefall berichtet, warum echte Routen versagt haben.
        if (lastErr) out.warning = String(lastErr.message || lastErr);
        return out;
      }
      const out = await callOpenAiCompatible(route, messages, opts);
      recordRoute(route.id, true);
      route.__toolRetry = false;
      return out;
    } catch (err) {
      // Groq gpt-oss ruft stochastisch (~1/3 am echten Agentenprompt) intern
      // ein Tool auf, obwohl der Request keine Tools definiert – Groq antwortet
      // mit 400 "Tool choice is none, but model called a tool". Das ist kein
      // Route-Defekt und kein Kontingent: ein sofortiger zweiter Versuch
      // derselben Route loest es fast immer auf. Kein Cooldown, keine
      // Eskalation, kein Failover-Wirbel.
      if (err.status === 400 && /tool choice is none/i.test(String(err.message)) && !route.__toolRetry) {
        route.__toolRetry = true;
        order.unshift(route);
        console.warn(`[villaforge] gpt-oss Tool-400 auf ${route.name}, einmal sofort erneut versuchen`);
        continue;
      }
      recordRoute(route.id, false);
      coolDown(route, err.status === 429);
      // Betriebs-Sichtbarkeit: ein gescheiterter LLM-Anruf muss im Hub-Log
      // sichtbar sein, sonst ist ein kippender Lauf nicht diagnostizierbar.
      console.error(`[villaforge] Route fehlgeschlagen (${route.name}): ${String(err.message || err).slice(0, 240)}`);
      lastErr = err;
      if (opts.onFailover) opts.onFailover(route.name, String(err.message || err));
    }
  }
  // Letzter Ausweg: Offline, damit der Ablauf nie hart scheitert.
  const fallback = offlineReply(messages, opts);
  fallback.intentional = !realConfigured;
  fallback.warning = lastErr ? String(lastErr.message || lastErr) : 'keine Route verfuegbar';
  return fallback;
}
