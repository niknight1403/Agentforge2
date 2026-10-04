/**
 * Zentrale Eingabevalidierung fuer die API.
 *
 * Alle Funktionen sind rein (keine DB, kein Netz) und damit direkt testbar.
 * Sie werfen nie, sondern geben { ok, error } zurueck, damit der Aufrufer
 * den passenden HTTP-Status setzen kann.
 */

/** Umgebungsvariablen-Name wie in Secrets-Store und key_env erwartet. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const HTTPS_OR_LOCAL = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/;

export function validateRoute(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body fehlt' };
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'name fehlt' };
  if (name.length > 120) return { ok: false, error: 'name zu lang (max. 120)' };
  const baseUrl = String(body.baseUrl || '').trim();
  if (!baseUrl) return { ok: false, error: 'baseUrl fehlt' };
  if (!HTTPS_OR_LOCAL.test(baseUrl)) {
    return { ok: false, error: 'baseUrl muss https:// sein (oder lokal 127.0.0.1/localhost)' };
  }
  const model = String(body.model || '').trim();
  if (!model) return { ok: false, error: 'model fehlt' };
  if (model.length > 200) return { ok: false, error: 'model zu lang (max. 200)' };
  const keyEnv = String(body.keyEnv || '').trim();
  if (keyEnv && !ENV_NAME.test(keyEnv)) return { ok: false, error: 'keyEnv muss ein grossgeschriebener Umgebungsname sein (z. B. GROQ_API_KEY)' };
  const priority = Number(body.priority);
  if (body.priority != null && (!Number.isFinite(priority) || priority < 1 || priority > 999)) {
    return { ok: false, error: 'priority muss zwischen 1 und 999 liegen' };
  }
  return { ok: true, value: { name, baseUrl: baseUrl.replace(/\/+$/, ''), model, keyEnv, priority: Math.round(priority) || 10 } };
}

export function validateSecret(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body fehlt' };
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'name fehlt' };
  if (!ENV_NAME.test(name)) return { ok: false, error: 'name muss einem Umgebungsvariablen-Muster folgen (A-Z, 0-9, _), z. B. GROQ_API_KEY' };
  const value = String(body.value || '');
  if (!value) return { ok: false, error: 'value fehlt' };
  if (value.length > 4096) return { ok: false, error: 'value zu lang (max. 4096)' };
  return { ok: true, value: { name, value } };
}

export function validateVilla(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body fehlt' };
  const idea = String(body.idea || '').trim();
  if (!idea) return { ok: false, error: 'idea fehlt' };
  if (idea.length > 2000) return { ok: false, error: 'idea zu lang (max. 2000 Zeichen)' };
  const name = String(body.name || 'Villa').trim().slice(0, 120) || 'Villa';
  const agentCount = Number(body.agentCount);
  if (body.agentCount != null && (!Number.isFinite(agentCount) || agentCount < 3 || agentCount > 1000)) {
    return { ok: false, error: 'agentCount muss zwischen 3 und 1000 liegen' };
  }
  const sourcePath = String(body.sourcePath || '').trim().slice(0, 1024);
  const mode = ['BUILD', 'ANALYZE'].includes(body.mode) ? body.mode : (sourcePath ? 'ANALYZE' : 'BUILD');
  return { ok: true, value: { idea, name, agentCount: Math.round(agentCount) || 12, sourcePath, mode } };
}

/**
 * Teil-Update einer Villa: nur die Felder, die im Body stehen, werden
 * geaendert (name, idea, mode). Ein leerer Body ist erlaubt und aendert nichts.
 */
export function validateVillaPatch(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body fehlt' };
  const out = {};
  if (body.name != null) {
    const name = String(body.name).trim().slice(0, 120);
    if (!name) return { ok: false, error: 'name darf nicht leer sein' };
    out.name = name;
  }
  if (body.idea != null) {
    const idea = String(body.idea).trim();
    if (!idea) return { ok: false, error: 'idea darf nicht leer sein' };
    if (idea.length > 2000) return { ok: false, error: 'idea zu lang (max. 2000 Zeichen)' };
    out.idea = idea;
  }
  if (body.mode != null) {
    if (!['BUILD', 'ANALYZE'].includes(body.mode)) return { ok: false, error: 'mode muss BUILD oder ANALYZE sein' };
    out.mode = body.mode;
  }
  if (Object.keys(body).some((k) => !['name', 'idea', 'mode'].includes(k))) {
    return { ok: false, error: 'nur name, idea und mode sind aenderbar' };
  }
  return { ok: true, value: out };
}

export function validateMessage(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body fehlt' };
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, error: 'message fehlt' };
  if (message.length > 8000) return { ok: false, error: 'message zu lang (max. 8000 Zeichen)' };
  return { ok: true, value: { message } };
}

/**
 * Grenzen fuer die Orchestrierung. Die clamps in orchestrate() sind die
 * letzte Verteidigung; hier wird frueh und mit klarer Fehlermeldung
 * abgelehnt, was das Budget eines Laufs sprengt.
 */
export function validateOrchestrate(body) {
  if (body == null || typeof body !== 'object') return { ok: true, value: {} };
  const out = {};
  if (body.concurrency != null) {
    const c = Number(body.concurrency);
    if (!Number.isFinite(c) || c < 1 || c > 16) {
      return { ok: false, error: 'concurrency muss zwischen 1 und 16 liegen' };
    }
    out.concurrency = Math.round(c);
  }
  if (body.maxTasks != null) {
    const t = Number(body.maxTasks);
    if (!Number.isFinite(t) || t < 1 || t > 5000) {
      return { ok: false, error: 'maxTasks muss zwischen 1 und 5000 liegen' };
    }
    out.maxTasks = Math.round(t);
  }
  if (body.maxRounds != null) {
    const r = Number(body.maxRounds);
    if (!Number.isFinite(r) || r < 1 || r > 20) {
      return { ok: false, error: 'maxRounds muss zwischen 1 und 20 liegen' };
    }
    out.maxRounds = Math.round(r);
  }
  if (body.adaptive != null && typeof body.adaptive !== 'boolean') {
    return { ok: false, error: 'adaptive muss true oder false sein' };
  }
  if (body.adaptive != null) out.adaptive = body.adaptive;
  return { ok: true, value: out };
}
