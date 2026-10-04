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

export function validateMessage(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body fehlt' };
  const message = String(body.message || '').trim();
  if (!message) return { ok: false, error: 'message fehlt' };
  if (message.length > 8000) return { ok: false, error: 'message zu lang (max. 8000 Zeichen)' };
  return { ok: true, value: { message } };
}
