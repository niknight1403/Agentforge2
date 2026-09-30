import { db, now } from './db.mjs';
import { OFFLINE_ROUTE } from './routes.mjs';

/** Liefert einen Key aus Secrets-Store oder Umgebung. */
export function resolveKey(keyEnv) {
  if (!keyEnv) return '';
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(keyEnv);
  if (row && row.value) return row.value;
  return process.env[keyEnv] || '';
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
  const routes = enabledRoutes().filter((r) => r.provider === 'offline' ? true : true);
  const usable = routes.filter((r) => r.provider === 'offline' || resolveKey(r.key_env));
  const pool = usable.length ? usable : routes;
  if (!pool.length) return { ...OFFLINE_ROUTE, id: 0, provider: 'offline' };

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

async function callOpenAiCompatible(route, messages, opts) {
  const key = resolveKey(route.key_env);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const body = {
    model: route.model,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 2048
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const res = await fetch(`${route.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0] ?? {};
  return {
    content: choice.message?.content ?? '',
    model: data.model ?? route.model,
    route: route.name,
    usage: data.usage ?? null
  };
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
  const strategy = opts.strategy || 'ROTATE';
  const order = [];
  if (routes.length) {
    let pool = routes.filter((r) => r.provider === 'offline' || resolveKey(r.key_env));
    if (!pool.length) pool = routes;
    pool = [...pool].sort((a, b) => (strategy === 'ROTATE'
      ? (a.priority - b.priority) || ((a.last_used || 0) - (b.last_used || 0))
      : a.priority - b.priority));
    order.push(...pool);
  }
  order.push({ ...OFFLINE_ROUTE, id: 0 });

  let lastErr = null;
  for (const route of order) {
    try {
      if (route.provider === 'offline') {
        return offlineReply(messages, opts);
      }
      const out = await callOpenAiCompatible(route, messages, opts);
      recordRoute(route.id, true);
      return out;
    } catch (err) {
      recordRoute(route.id, false);
      lastErr = err;
      if (opts.onFailover) opts.onFailover(route.name, String(err.message || err));
    }
  }
  // Letzter Ausweg: Offline, damit der Ablauf nie hart scheitert.
  const fallback = offlineReply(messages, opts);
  fallback.warning = lastErr ? String(lastErr.message || lastErr) : 'keine Route verfuegbar';
  return fallback;
}
