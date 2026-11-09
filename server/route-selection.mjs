/**
 * Route-Zulassung — Brücke zwischen der Routentabelle (`server/llm.mjs`) und
 * dem Kontingent-Ledger (`server/route-quota.mjs`).
 *
 * Warum eine Brücke und nicht direkt der Ledger: die produktiven Routen stehen
 * in der SQLite-Tabelle `routes` (auf der VM über 20 Stück), der Ledger kennt
 * dagegen nur Einträge, die ihm jemand übergibt. Diese Schicht übersetzt eine
 * DB-Route einmalig in ein Ledger-Konto und merkt sich das.
 *
 * Zwei Regeln, die hier durchgesetzt werden:
 *
 *   1. Kontingent gehört dem Konto, nicht der Route. Konto = `key_env`
 *      (derselbe Schlüssel), sonst der Anbieter. Zwei Routen mit demselben
 *      Schlüssel teilen also ein Limit, statt sich gegenseitig freizuspielen.
 *   2. Standard ist ausschließlich lokal (`LLM_LOCAL_ONLY=1`): Routen ohne
 *      lokalen Endpunkt werden nicht zugelassen. Wer freie Tarife als Burst
 *      will, setzt das bewusst auf `0`.
 *
 * Der Schalter `VF_ROUTE_LEDGER=1` aktiviert die Zulassung. Ohne ihn verhält
 * sich der Aufrufpfad exakt wie vorher — die Verdrahtung ist damit ohne
 * Risiko für den laufenden Betrieb zu prüfen.
 */

import { QuotaLedger, loadState, saveState } from './route-quota.mjs';

/** Grenzwerte je Anbieter, wenn `config/routes.json` keinen Eintrag hat. */
export const PROVIDER_LIMITS = Object.freeze({
  gemini: { rpm: 8, rpd: 1200, tpm: 1_000_000, tpd: 0 },
  groq: { rpm: 20, rpd: 1000, tpm: 12_000, tpd: 0 },
  cerebras: { rpm: 10, rpd: 900, tpm: 60_000, tpd: 0 },
  mistral: { rpm: 5, rpd: 400, tpm: 40_000, tpd: 0 },
  openrouter: { rpm: 12, rpd: 50, tpm: 0, tpd: 0 },
  ollama: { rpm: 0, rpd: 0, tpm: 0, tpd: 0 },
  offline: { rpm: 0, rpd: 0, tpm: 0, tpd: 0 }
});

const LOCAL_HOSTS = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|[^/]*\.local|host\.docker\.internal|10\.|192\.168\.)/i;

export function isLocalEndpoint(baseUrl) {
  return LOCAL_HOSTS.test(String(baseUrl || ''));
}

/** Konto-Schlüssel einer DB-Route: derselbe Schlüssel bedeutet dasselbe Konto. */
export function accountOf(route) {
  const keyEnv = String(route?.key_env || '').trim();
  if (keyEnv) return `key:${keyEnv}`;
  return `provider:${String(route?.provider || route?.name || 'unbekannt')}`;
}

/** Limits einer DB-Route: Anbietergrenze, überschrieben durch die Konfiguration. */
export function limitsOf(route, overrides = []) {
  const provider = String(route?.provider || '').toLowerCase();
  const byId = overrides.find((entry) => entry.id && (entry.id === route?.name || entry.id === route?.id));
  const basis = PROVIDER_LIMITS[provider] || { rpm: 10, rpd: 300, tpm: 0, tpd: 0 };
  const ausConfig = byId?.limits || {};
  return {
    rpm: Number(ausConfig.rpm ?? basis.rpm) || 0,
    rpd: Number(ausConfig.rpd ?? basis.rpd) || 0,
    tpm: Number(ausConfig.tpm ?? basis.tpm) || 0,
    tpd: Number(ausConfig.tpd ?? basis.tpd) || 0
  };
}

function tokensFromMessages(messages) {
  const text = JSON.stringify(messages ?? '');
  return Math.max(200, Math.round(text.length / 4));
}

export function createRouteAdmission({
  clock = Date.now,
  env = process.env,
  overrides = [],
  file = ''
} = {}) {
  const enabled = String(env.VF_ROUTE_LEDGER || '0') === '1';
  const localOnly = String(env.LLM_LOCAL_ONLY ?? '1') !== '0';
  const stateFile = file || String(env.VF_ROUTE_LEDGER_STATE || '');
  const ledger = new QuotaLedger({ clock });
  if (stateFile) ledger.restore(loadState(stateFile, clock));
  const seen = new Set();

  function register(route) {
    if (!route || route.id === undefined || route.id === null || route.id === '') return null;
    const id = String(route.id);
    /* Einmal registrieren, dann merken: ein zweites register() wuerde die
       gezaehlten Fenster und Pausen der Route zuruecksetzen. */
    if (seen.has(id)) return ledger.get(id);
    seen.add(id);
    return ledger.register({
      id,
      account: accountOf(route),
      kind: String(route.provider || 'openai'),
      priority: Number(route.priority) || 50,
      isLocal: isLocalEndpoint(route.base_url) || String(route.provider || '') === 'ollama',
      needsKey: Boolean(route.key_env),
      tools: true,
      baseUrl: String(route.base_url || ''),
      model: String(route.model || ''),
      limits: limitsOf(route, overrides),
      limitsVerified: Boolean(overrides.some((entry) => entry.id && (entry.id === route.name || entry.id === route.id)))
    });
  }

  /** Zulassung vor dem Aufruf: verweigert, bevor ein Aufruf rausgeht. */
  function admit(route, { tokens = 0, needsTools = false } = {}) {
    if (!enabled) return { ok: true, reason: '', retryAfterMs: 0, disabled: true };
    const local = isLocalEndpoint(route?.base_url) || String(route?.provider || '') === 'ollama';
    if (localOnly && !local) {
      return { ok: false, reason: 'local_only', retryAfterMs: 0, message: 'Nur lokale Route zugelassen (LLM_LOCAL_ONLY=1).' };
    }
    const entry = register(route);
    if (!entry) return { ok: true, reason: '', retryAfterMs: 0 };
    const result = ledger.consume(entry.id, { tokens: Number(tokens) || 0 });
    if (!result.ok) return { ok: false, reason: result.reason, retryAfterMs: result.retryAfterMs };
    if (needsTools && entry.tools === false) return { ok: false, reason: 'kein_werkzeug', retryAfterMs: 0 };
    return { ok: true, reason: '', retryAfterMs: 0 };
  }

  /** Ergebnis verbuchen: Erfolg räumt Pausen ab, Fehler sperren das Konto. */
  function settle(route, { ok = true, status = 200, retryAfterMs = 0, reason = '' } = {}) {
    if (!enabled || !route?.id) return { cooldownMs: 0, reason: '' };
    const entry = register(route);
    if (!entry) return { cooldownMs: 0, reason: '' };
    const out = ledger.settle(entry.id, { ok, status, retryAfterMs, reason });
    if (stateFile) {
      try {
        saveState(stateFile, ledger.toJSON());
      } catch {
        // Zustand ist Komfort, nicht Bedingung: ein Schreibfehler darf den
        // Modellaufruf nicht scheitern lassen.
      }
    }
    return out;
  }

  /** Nächste Route aus einer Liste, ohne selbst zu rufen (für Planer/Tests). */
  function next(routes, { tokens = 0, needsTools = false } = {}) {
    const lokal = [];
    for (const route of routes || []) {
      const local = isLocalEndpoint(route?.base_url) || String(route?.provider || '') === 'ollama';
      if (localOnly && !local) continue;
      register(route);
      lokal.push(route);
    }
    if (!lokal.length) return { route: null, reason: localOnly ? 'local_only' : 'keine_route' };
    const result = ledger.next({ tokens, needsTools });
    if (!result.route) return { route: null, reason: result.reason, gaps: result.gaps };
    return { route: lokal.find((route) => String(route.id) === result.route.id) || null, reason: '' };
  }

  return {
    enabled,
    localOnly,
    ledger,
    stateFile,
    estimateTokens: tokensFromMessages,
    accountOf,
    limitsOf,
    isLocalEndpoint,
    admit,
    settle,
    next,
    status: () => ledger.status(),
    plan: (options) => ledger.plan(options)
  };
}

export const routeAdmission = createRouteAdmission();
