/**
 * Route-Quota — Kontingent-Buchhaltung, Rotation und Kapazitätsplanung für 24/7-Betrieb.
 *
 * Der Hunter findet Routen, der Cascade ordnet sie. Was fehlte: wer mitzählt,
 * wie viel jede Route in dieser Minute und an diesem Tag schon verbraucht hat,
 * wer bei 429 die Route schon und eine andere nimmt, und wer vorher sagt, ob
 * die vorhandenen Routen eine geforderte Last überhaupt tragen.
 *
 * Genau das macht dieses Modul, ohne Datenbankmigration und ohne Netzzugriff:
 *
 *   const ledger = new QuotaLedger({ routes, clock });
 *   const pick = ledger.next({ tokens: 1500, needsTools: true });
 *   if (!pick.route) return report(pick.gaps);
 *   const ticket = ledger.consume(pick.route.id, { tokens: 1500 });
 *   ... Aufruf ...
 *   ledger.settle(pick.route.id, { ok: true, tokens: 1400 });
 *
 * Fenster laufen rollierend (60 s und 24 h), nicht nach Kalendertag: ein
 * Anbieter setzt sein Tageslimit zurück, wann er will, deshalb rechnet der
 * Ledger konservativ über die letzten 24 Stunden.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const WINDOW_MINUTE_MS = 60_000;
export const WINDOW_DAY_MS = 86_400_000;

/** Vorgaben der Sicherung: 3 Fehler in Folge, dann wachsende Pause. */
export const BREAKER = Object.freeze({ threshold: 3, baseMs: 60_000, maxMs: 30 * 60_000 });

/** Pausen je Fehlerklasse, wenn der Anbieter kein Retry-After schickt. */
export const COOLDOWNS = Object.freeze({
  rate_limit: 120_000,
  quota: 3_600_000,
  auth: 900_000,
  server_error: 60_000,
  network: 30_000
});

const ZERO_LIMITS = Object.freeze({ rpm: 0, rpd: 0, tpm: 0, tpd: 0 });

function limitOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function failureClass(status, reason) {
  if (reason) return reason;
  const code = Number(status) || 0;
  if (code === 429) return 'rate_limit';
  if (code === 401 || code === 403) return 'auth';
  if (code >= 500) return 'server_error';
  if (code === 0) return 'network';
  return 'server_error';
}

function quotaError(reason) {
  return Object.assign(new Error(reason), { code: reason });
}

export class QuotaLedger {
  /**
   * @param {object} options
   * @param {Array<object>} options.routes  Routen aus config/routes.json
   * @param {() => number} [options.clock]  Zeitquelle (Tests setzen eine feste)
   * @param {string} [options.file]         Zustandsdatei für Neustarts
   */
  constructor({ routes = [], clock = Date.now, file = '' } = {}) {
    this.clock = clock;
    this.file = file;
    this.routes = new Map();
    // Konto-Sperren liegen ueber den Routen: ein 429 gehoert dem Schluessel,
    // auch wenn eine Schwesterroute erst spaeter registriert wird.
    this.accountCooldowns = new Map();
    for (const route of routes) this.register(route);
  }

  register(route = {}) {
    if (!route.id) throw quotaError('route ohne id');
    const limits = { ...ZERO_LIMITS, ...(route.limits || {}) };
    const kontoSperre = this.accountCooldowns.get(route.account || route.id);
    this.routes.set(route.id, {
      id: route.id,
      // Kontingent haengt am Konto des Anbieters, nicht an der Route: zwei
      // Routen mit demselben Schluessel teilen ein Limit. Ohne Konto-Angabe
      // ist die Route ihr eigenes Konto.
      account: route.account || route.id,
      kind: route.kind || 'openai',
      priority: Number(route.priority) || 50,
      isLocal: route.isLocal === true,
      needsKey: route.needsKey !== false,
      tools: route.tools !== false,
      apiKeyEnv: route.apiKeyEnv || '',
      baseUrl: route.baseUrl || '',
      model: route.model || '',
      limitsVerified: route.limitsVerified === true,
      enabled: route.enabled !== false,
      limits: {
        rpm: limitOf(limits.rpm),
        rpd: limitOf(limits.rpd),
        tpm: limitOf(limits.tpm),
        tpd: limitOf(limits.tpd)
      },
      events: [],
      cooldownUntil: kontoSperre && kontoSperre.until > this.clock() ? kontoSperre.until : 0,
      lastCooldownReason: '',
      failures: 0,
      successes: 0,
      breakerMs: 0
    });
    return this.routes.get(route.id);
  }

  get(routeId) {
    return this.routes.get(routeId) || null;
  }

  list() {
    return [...this.routes.values()];
  }

  #prune(route, now) {
    const since = now - WINDOW_DAY_MS;
    route.events = route.events.filter((entry) => entry.ts > since);
  }

  /** Verbrauch in beiden Fenstern, ohne etwas zu buchen. */
  usage(routeId) {
    const route = this.routes.get(routeId);
    if (!route) throw quotaError(`unbekannte Route: ${routeId}`);
    const now = this.clock();
    this.#prune(route, now);
    const minute = route.events.filter((entry) => entry.ts > now - WINDOW_MINUTE_MS);
    const sum = (entries) => entries.reduce((total, entry) => total + entry.tokens, 0);
    return {
      usedMinute: minute.length,
      usedDay: route.events.length,
      tokensMinute: sum(minute),
      tokensDay: sum(route.events),
      cooldownUntil: route.cooldownUntil,
      cooldownMs: Math.max(0, route.cooldownUntil - now)
    };
  }

  /** Würde diese Route jetzt einen Auftrag dieser Größe annehmen? */
  #admits(route, tokens, now) {
    if (!route.enabled) return 'deaktiviert';
    if (route.cooldownUntil > now) return 'cooldown';
    const konto = this.accountCooldowns.get(route.account);
    if (konto && konto.until > now) return 'cooldown';
    const usage = this.usage(route.id);
    const { rpm, rpd, tpm, tpd } = route.limits;
    if (rpm && usage.usedMinute + 1 > rpm) return 'rpm';
    if (rpd && usage.usedDay + 1 > rpd) return 'rpd';
    if (tpm && usage.tokensMinute + tokens > tpm) return 'tpm';
    if (tpd && usage.tokensDay + tokens > tpd) return 'tpd';
    return '';
  }

  /** Bucht einen Auftrag. Gibt bei Ablehnung den Grund zurück, statt zu werfen. */
  consume(routeId, { tokens = 0 } = {}) {
    const route = this.routes.get(routeId);
    if (!route) throw quotaError(`unbekannte Route: ${routeId}`);
    const now = this.clock();
    const refusal = this.#admits(route, Math.max(0, Number(tokens) || 0), now);
    if (refusal) {
      const usage = this.usage(routeId);
      return { ok: false, reason: refusal, retryAfterMs: usage.cooldownMs, route: route.id };
    }
    route.events.push({ ts: now, tokens: Math.max(0, Number(tokens) || 0) });
    return { ok: true, reason: '', route: route.id };
  }

  /** Ergebnis eines Aufrufs verbuchen: Erfolg räumt Pausen ab, Fehler legen eine an. */
  settle(routeId, { ok = true, status = 200, retryAfterMs = 0, reason = '' } = {}) {
    const route = this.routes.get(routeId);
    if (!route) throw quotaError(`unbekannte Route: ${routeId}`);
    const now = this.clock();
    if (ok) {
      route.successes += 1;
      route.failures = 0;
      route.breakerMs = 0;
      route.cooldownUntil = 0;
      route.lastCooldownReason = '';
      return { cooldownMs: 0, reason: '' };
    }
    const kind = failureClass(status, reason);
    route.failures += 1;
    let pause = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : COOLDOWNS[kind] || COOLDOWNS.server_error;
    if (route.failures >= BREAKER.threshold) {
      route.breakerMs = route.breakerMs ? Math.min(route.breakerMs * 2, BREAKER.maxMs) : BREAKER.baseMs;
      pause = Math.max(pause, route.breakerMs);
    }
    route.cooldownUntil = now + pause;
    route.lastCooldownReason = kind;
    let affected = 1;
    if (kind === 'rate_limit' || kind === 'quota' || kind === 'auth') {
      // Kontoweite Sperre: greift auch fuer Routen, die dieser Prozess noch
      // nicht gesehen hat (deshalb separat gespeichert, nicht nur an der Route).
      const bisher = this.accountCooldowns.get(route.account);
      const until = Math.max(now + pause, bisher?.until || 0);
      this.accountCooldowns.set(route.account, { until, reason: kind });
      // Ein Limit gehoert dem Konto: weitere Routen desselben Kontos sind
      // genauso gesperrt. Sonst rotiert der Betrieb scheinbar weiter und
      // laeuft in dieselbe Wand.
      for (const other of this.routes.values()) {
        if (other.id === route.id || other.account !== route.account) continue;
        other.cooldownUntil = Math.max(other.cooldownUntil, now + pause);
        other.lastCooldownReason = kind;
        affected += 1;
      }
    }
    return { cooldownMs: pause, reason: kind, affectedRoutes: affected };
  }

  /** Anteil des Tageskontingents, der noch frei ist (1 = voll, 0 = erschöpft). */
  headroom(routeId) {
    const route = this.routes.get(routeId);
    const usage = this.usage(routeId);
    if (!route.limits.rpd) return route.isLocal ? 1 : 0.5;
    return Math.max(0, (route.limits.rpd - usage.usedDay) / route.limits.rpd);
  }

  #successRate(route) {
    const total = route.successes + route.failures;
    if (!total) return 0.75;
    return route.successes / total;
  }

  /**
   * Nächste Route für einen Auftrag.
   * Reihenfolge: eigene Hardware zuerst (kein Fremdkontingent), dann freie
   * Routen mit dem meisten Restkontingent und der besten Trefferquote.
   */
  next({ tokens = 0, needsTools = false, exclude = [] } = {}) {
    const now = this.clock();
    const skip = new Set(exclude.filter(Boolean));
    const gaps = [];
    const candidates = [];
    for (const route of this.routes.values()) {
      if (skip.has(route.id)) continue;
      if (needsTools && !route.tools) {
        gaps.push({ route: route.id, reason: 'kein Werkzeugaufruf' });
        continue;
      }
      const refusal = this.#admits(route, Math.max(0, Number(tokens) || 0), now);
      if (refusal) {
        gaps.push({ route: route.id, reason: refusal });
        continue;
      }
      const score = route.isLocal ? -1 : this.headroom(route.id) * this.#successRate(route);
      candidates.push({ route, score });
    }
    candidates.sort((a, b) => {
      // Eigene Hardware immer zuerst, unabhängig vom Restkontingent.
      if (a.route.isLocal !== b.route.isLocal) return a.route.isLocal ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      if (a.route.priority !== b.route.priority) return a.route.priority - b.route.priority;
      return a.route.id.localeCompare(b.route.id);
    });
    if (!candidates.length) {
      return { route: null, gaps, reason: 'keine Route mit Restkontingent' };
    }
    return { route: candidates[0].route, gaps, reason: '' };
  }

  /**
   * Trägt die vorhandene Route eine geforderte Last? Rechnet bewusst
   * konservativ über 24 Stunden und nennt den Fehlbetrag in Aufträgen.
   */
  plan({ demandPerHour = 1, horizonHours = 24, tokensPerRequest = 1500 } = {}) {
    const now = this.clock();
    const hours = Math.max(1, Number(horizonHours) || 24);
    const demand = Math.ceil(Math.max(0, Number(demandPerHour) || 0) * hours);
    const perRoute = [];
    let finiteCapacity = 0;
    let localHealthy = false;
    const unverified = [];

    let finiteByAccount = 0;
    const accountCapacity = new Map();
    for (const route of this.routes.values()) {
      const usage = this.usage(route.id);
      const byDay = route.limits.rpd ? Math.max(0, route.limits.rpd - usage.usedDay) : Infinity;
      const byMinute = route.limits.rpm ? Math.max(0, route.limits.rpm - usage.usedMinute) + route.limits.rpm * 60 * hours : Infinity;
      const byTokens = route.limits.tpd
        ? Math.floor(Math.max(0, route.limits.tpd - usage.tokensDay) / Math.max(1, tokensPerRequest))
        : Infinity;
      const capacity = Math.min(byDay, byMinute, byTokens);
      const usable = route.enabled && route.cooldownUntil <= now;
      if (!route.limitsVerified) unverified.push(route.id);
      if (route.isLocal) {
        if (usable) localHealthy = true;
        perRoute.push({ route: route.id, account: route.account, isLocal: true, usable, capacity: usable ? 'unbegrenzt' : 0 });
        continue;
      }
      const admitted = usable ? capacity : 0;
      if (Number.isFinite(admitted)) {
        // Mehrere Routen eines Kontos teilen ein Limit: es zaehlt die beste
        // Route des Kontos, nicht die Summe. Sonst rechnet der Plan zu optimistisch.
        const bisher = accountCapacity.get(route.account) || 0;
        if (admitted > bisher) {
          finiteByAccount += admitted - bisher;
          accountCapacity.set(route.account, admitted);
        }
      }
      perRoute.push({ route: route.id, account: route.account, isLocal: false, usable, capacity: admitted });
    }
    finiteCapacity = finiteByAccount;

    const covered = localHealthy ? demand : Math.min(demand, finiteCapacity);
    const shortfall = Math.max(0, demand - covered);
    const advice = [];
    if (localHealthy) {
      advice.push('Eigene Hardware trägt die Last: kein Fremdkontingent nötig, keine Rotation erforderlich.');
    } else {
      advice.push('Lokale Route ist nicht nutzbar: für 24/7 zuerst Ollama auf eigener Hardware starten (größter Hebel, kein Limit).');
    }
    if (shortfall > 0) {
      const biggest = perRoute
        .filter((row) => !row.isLocal && Number.isFinite(row.capacity))
        .sort((a, b) => b.capacity - a.capacity)[0];
      advice.push(`Fehlbetrag ${shortfall} Aufträge auf ${hours} h. Zusätzliche Route mit mindestens ${shortfall} Aufträgen/Tag nötig.`);
      if (biggest) advice.push(`Beispiel: eine weitere Instanz von ${biggest.route} deckt bis ${biggest.capacity} Aufträge/Tag.`);
    }
    if (unverified.length) {
      advice.push(`Limits unbestätigt für: ${unverified.join(', ')}. Werte im Anbieter-Dashboard prüfen und in config/routes.json setzen.`);
    }
    return {
      demand,
      horizonHours: hours,
      tokensPerRequest,
      covered,
      shortfall,
      localHealthy,
      finiteCapacity: Number.isFinite(finiteCapacity) ? finiteCapacity : 'unbegrenzt',
      perRoute,
      advice
    };
  }

  /** Kompakte Übersicht für Statusseiten und Logs. */
  status() {
    const now = this.clock();
    return this.list().map((route) => {
      const usage = this.usage(route.id);
      return {
        id: route.id,
        account: route.account,
        kind: route.kind,
        isLocal: route.isLocal,
        enabled: route.enabled,
        usable: route.enabled && route.cooldownUntil <= now,
        cooldownMs: usage.cooldownMs,
        cooldownReason: route.lastCooldownReason,
        usedMinute: usage.usedMinute,
        usedDay: usage.usedDay,
        limits: route.limits,
        limitsVerified: route.limitsVerified,
        headroom: Number(this.headroom(route.id).toFixed(3)),
        successRate: Number(this.#successRate(route).toFixed(3)),
        failures: route.failures
      };
    });
  }

  toJSON() {
    const routes = {};
    for (const route of this.routes.values()) {
      routes[route.id] = {
        events: route.events,
        cooldownUntil: route.cooldownUntil,
        lastCooldownReason: route.lastCooldownReason,
        failures: route.failures,
        successes: route.successes,
        breakerMs: route.breakerMs
      };
    }
    const accounts = {};
    for (const [account, entry] of this.accountCooldowns) accounts[account] = entry;
    return { version: 2, savedAt: this.clock(), routes, accounts };
  }

  restore(snapshot = {}) {
    for (const [account, entry] of Object.entries(snapshot.accounts || {})) {
      if (entry && Number(entry.until) > 0) {
        this.accountCooldowns.set(account, { until: Number(entry.until), reason: entry.reason || '' });
      }
    }
    const saved = snapshot.routes || {};
    for (const route of this.routes.values()) {
      const entry = saved[route.id];
      if (!entry) continue;
      route.events = Array.isArray(entry.events) ? entry.events.filter((e) => Number.isFinite(e?.ts)) : [];
      route.cooldownUntil = Number(entry.cooldownUntil) || 0;
      route.lastCooldownReason = entry.lastCooldownReason || '';
      route.failures = Number(entry.failures) || 0;
      route.successes = Number(entry.successes) || 0;
      route.breakerMs = Number(entry.breakerMs) || 0;
    }
    return this;
  }
}

/** Lädt Routen aus config/routes.json (ohne Netzzugriff). */
export function loadRouteConfig(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed.routes) ? parsed.routes : [];
}

/** Zustand laden, falls die Datei existiert; fehlertolerant (Neustart nach Absturz). */
export function loadState(file, clock = Date.now) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, savedAt: clock(), routes: {} };
  }
}

/** Zustand atomar schreiben: erst temporär, dann umbenennen. */
export function saveState(file, snapshot) {
  if (!file) return false;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return true;
}

/** Ledger mit Konfiguration und gespeichertem Zustand aufbauen. */
export function createLedger({ routes = [], clock = Date.now, file = '' } = {}) {
  const ledger = new QuotaLedger({ routes, clock });
  ledger.file = file;
  if (file) ledger.restore(loadState(file, clock));
  return ledger;
}
