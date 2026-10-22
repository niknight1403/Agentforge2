// ============================================================================
// KEYFORGE-AGENT — autonomer Lebenszyklus fuer LLM-API-Keys.
//
// Auftrag (Master-Agent-Charta 2026-10-18): Neue Keys, die im Secrets-Store
// ankommen, werden automatisch identifiziert (Provider anhand der Key-Struktur),
// mit einer Mini-Probe validiert, mit passenden Routen verdrahtet und im
// System-Log dokumentiert. Ehrliche Grenze: Die wenigsten Provider erlauben
// das programmatische ANLEGEN von Accounts/Keys (Signup braucht einen Menschen)
// - KeyForge verwaltet dafuer vollautonom alles, was rein kommt: Validierung,
// Dedup, Routing, Gating-Erkennung und Protokollierung.
//
// Architektur: kein neues Framework, nur Hub-Bordmittel (node:sqlite, fetch).
// ============================================================================

import { db, now } from './db.mjs';
import { isFreeRoute } from './llm-config.mjs';

// System-Log: jede Aktion von KeyForge/RouteForge landet hier (Charta-Forderung).
db.exec(`
CREATE TABLE IF NOT EXISTS keyforge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
)`);

export function forgeLog(action, detail) {
  db.prepare('INSERT INTO keyforge_log (ts, action, detail) VALUES (?,?,?)')
    .run(now(), String(action), String(detail).slice(0, 500));
  console.log(new Date().toISOString(), '[keyforge]', action, '-', String(detail).slice(0, 220));
}

export function recentForgeLog(limit = 20) {
  return db.prepare('SELECT id, ts, action, detail FROM keyforge_log ORDER BY id DESC LIMIT ?').get
    ? db.prepare('SELECT id, ts, action, detail FROM keyforge_log ORDER BY id DESC LIMIT ?').all(Number(limit) || 20)
    : [];
}

// ---- Provider-Erkennung anhand der Key-Struktur ---------------------------

export function classifyKey(value) {
  const v = String(value || '').trim();
  if (/^gsk_/.test(v)) return 'groq';
  if (/^sk-or-v1-/.test(v)) return 'openrouter';
  if (/^AIza/.test(v)) return 'google';
  if (/^AQ\./.test(v)) return 'google'; // Neues Google-Key-Format (2026, live verifiziert)
  if (/^hf_/.test(v)) return 'huggingface';
  if (/^xai-/.test(v)) return 'xai';
  if (/^csk-/.test(v)) return 'cerebras';
  return null; // unidentifiziert: wird geloggt, aber nie geroutet
}

export const PROVIDER_CATALOG = {
  groq: {
    label: 'Groq',
    routeProvider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    probeModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
    // 429 auf der Probe = Quota-Sturm, Key ist trotzdem gut: Routen anlegen.
    routeOn429: true
  },
  google: {
    label: 'Google Gemini',
    routeProvider: 'gemini-openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    probeModel: 'gemini-3.1-flash-lite',
    models: ['gemini-3.1-flash-lite'],
    routeOn429: true // Tageskontingent kehrt zurueck
  },
  openrouter: {
    label: 'OpenRouter',
    routeProvider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    probeModel: 'openrouter/free',
    models: ['openrouter/free'],
    routeOn429: false // free-Modelle koennen bei Tageslimit 429 liefern
  },
  cerebras: {
    label: 'Cerebras',
    routeProvider: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    probeModel: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'qwen-3.8-27b'],
    routeOn429: true
  },
  huggingface: {
    label: 'Hugging Face Inference',
    routeProvider: 'huggingface',
    baseUrl: 'https://router.huggingface.co/v1',
    probeModel: process.env.VF_HF_MODEL || 'openai/gpt-oss-120b:cerebras',
    models: [process.env.VF_HF_MODEL || 'openai/gpt-oss-120b:cerebras'],
    routeOn429: false
  },
  xai: {
    label: 'xAI',
    routeProvider: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    probeModel: process.env.VF_XAI_MODEL || '',
    models: process.env.VF_XAI_MODEL ? [process.env.VF_XAI_MODEL] : [],
    routeOn429: true
  }
};

const GATED_PATTERNS = /rate limit exceeded|free-models-per-day|only available|unavailable for free|add \$?\d+ (credits?|in credits)/i;

// ---- Validierung: eine Mini-Probe je Key ---------------------------------

export async function probeKey(provider, value) {
  const spec = PROVIDER_CATALOG[provider];
  if (!spec) return { ok: false, state: 'UNKNOWN', reason: 'Provider unbekannt' };
  try {
    const res = await fetch(`${spec.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value}` },
      body: JSON.stringify({ model: spec.probeModel, messages: [{ role: 'user', content: 'ok' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(20_000)
    });
    const text = await res.text().catch(() => '');
    if (res.ok) {
      const body = JSON.parse(text || '{}');
      const content = body.choices?.[0]?.message?.content || '';
      if (GATED_PATTERNS.test(content)) {
        return { ok: false, state: 'GATED', reason: content.slice(0, 160) };
      }
      return { ok: true, state: 'OK' };
    }
    if (res.status === 429) {
      return spec.routeOn429
        ? { ok: true, state: 'RATE_LIMITED', reason: '429 auf Probe - Key gueltig, Route trotzdem anlegen' }
        : { ok: false, state: 'GATED', reason: `429: ${text.slice(0, 140)}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, state: 'DEAD', reason: `HTTP ${res.status}` };
    }
    return { ok: false, state: 'ERROR', reason: `HTTP ${res.status} ${text.slice(0, 140)}` };
  } catch (e) {
    return { ok: false, state: 'ERROR', reason: e.message || String(e) };
  }
}

// ---- Prioritaets-Allokation: kleinster freier Block >= 8 ------------------

export function nextFreePriority(blockSize) {
  const used = new Set(
    db.prepare('SELECT priority FROM routes WHERE enabled = 1').all()
      .map((r) => Number(r.priority) || 0)
  );
  let p = 8;
  let guard = 0;
  while (guard++ < 200) {
    let free = true;
    for (let i = 0; i < blockSize; i++) if (used.has(p + i)) free = false;
    if (free) return p;
    p += 2; // Blockabstand: Platz fuer spaetere KeyForge-Experimente
  }
  return p;
}

// ---- Tick: Secrets scannen, validieren, Routen anlegen, loggen ------------

const lastProbe = new Map(); // secretName -> ts der letzten Probe
const PROBE_THROTTLE_MS = 30 * 60_000;

function hasRoutes(keyEnv) {
  return db.prepare('SELECT COUNT(*) c FROM routes WHERE key_env = ?').get(keyEnv).c > 0;
}

function loggedRecently(action, needle, minAgoMs = 60 * 60_000) {
  const row = db.prepare(
    'SELECT MAX(ts) t FROM keyforge_log WHERE action = ? AND detail LIKE ?'
  ).get(action, `%${needle}%`);
  return row && row.t && now() - row.t < minAgoMs;
}

export async function keyforgeTick() {
  const secrets = db.prepare('SELECT name, value FROM secrets').all();

  // Gleicher Key-Wert unter mehreren Namen (z.B. GEMINI_API_KEY und GROQ_API_KEY
  // mit identischem gsk_-Wert): genau ein Routen-Owner, keine Doppelrouten.
  const byValue = new Map();
  for (const s of secrets) {
    if (!s.value) continue;
    if (!byValue.has(s.value)) byValue.set(s.value, []);
    byValue.get(s.value).push(s.name);
  }

  const actions = [];
  for (const [value, names] of byValue) {
    const provider = classifyKey(value);
    if (!provider) {
      for (const name of names) {
        if (!loggedRecently('unidentified', name, 24 * 60 * 60_000)) {
          forgeLog('unidentified', `Key ${name} (${value.length} Zeichen) keinem Provider zugeordnet - nicht geroutet`);
        }
      }
      continue;
    }
    const spec = PROVIDER_CATALOG[provider];
    if (!spec) {
      forgeLog('unsupported', `Key ${names[0]} erkannt (${provider}), aber kein Routenadapter konfiguriert`);
      continue;
    }
    if (!spec.models.length || !spec.probeModel) {
      forgeLog('unconfigured', `${spec.label}: Modell fehlt; passenden Modellnamen in der Umgebung konfigurieren`);
      continue;
    }
    const owner = names.find((n) => hasRoutes(n)) || [...names].sort()[0];

    if (hasRoutes(owner)) continue; // bereits vollstaendig geroutet

    // Probe-Throttle: jede Validierung kostet Provider-Kontingent.
    const probeTs = Math.max(...names.map((n) => lastProbe.get(n) || 0));
    if (now() - probeTs < PROBE_THROTTLE_MS && !loggedRecently('route', owner, PROBE_THROTTLE_MS)) continue;
    for (const n of names) lastProbe.set(n, now());

    const probe = await probeKey(provider, value);
    if (!probe.ok) {
      if (!loggedRecently('probe:' + probe.state, owner, PROBE_THROTTLE_MS)) {
        forgeLog('probe:' + probe.state, `${owner} [${spec.label}]: ${probe.reason || probe.state}`);
      }
      continue;
    }

    // Gueltig (oder Rate-Sturm bei Cloud-Providern): Routen anlegen.
    const p = nextFreePriority(spec.models.length);
    spec.models.forEach((model, i) => {
      const name = `${spec.label} ${model.split('/').pop()} (${owner})`;
      db.prepare(
        `INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used)
         VALUES (?,?,?,?,?,?,1,?,1,'NEW',0,0,0)`
      ).run(name, spec.routeProvider, spec.baseUrl, model, owner, Number(isFreeRoute({provider:spec.routeProvider,base_url:spec.baseUrl,model})), p + i);
      forgeLog('route', `Neue Route [${name}] P${p + i} mit Key ${owner} (${spec.label}, Probe: ${probe.state})`);
      actions.push({ key: owner, provider, route: name, priority: p + i, probe: probe.state });
    });
  }
  return { keys: byValue.size, actions };
}

export function keyforgeStatus() {
  const log = db.prepare('SELECT id, ts, action, detail FROM keyforge_log ORDER BY id DESC LIMIT 20').all();
  const keys = db.prepare('SELECT name, value FROM secrets').all();
  const classified = keys
    .filter((k) => k.value)
    .map((k) => ({ name: k.name, provider: classifyKey(k.value), routed: hasRoutes(k.name) }));
  return { log, keys: classified };
}
