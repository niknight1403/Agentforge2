/**
 * Typisierte Event-Vertraege fuer den produktiven Redis-Stream-Bus (event-mesh.mjs).
 *
 * Warum dieses Modul: Der Hub ist bewusst abhaengigkeitsfrei (ESM/.mjs, einzige
 * Dependency `stripe`). Der TypeScript-Core unter `core/` haengt dagegen an
 * ioredis, axios, @opentelemetry/* und Prisma und wird von `server/` nirgends
 * importiert - er ist damit keine Typquelle fuer die Laufzeit. Diese Datei ist
 * die verbindliche Typdefinition der tatsaechlich publizierten Events:
 * JSDoc-Typen fuer die Entwickler-Sicht und `validateMeshEvent()` fuer die
 * Laufzeitpruefung (Tests und optionale Emit-Pruefung).
 *
 * Schutzziel: Events enthalten ausschliesslich Metadaten. Prompts, Werkzeug-
 * argumente, Modellantworten und Gedankengaenge duerfen niemals Teil eines
 * Events sein. Felder ausserhalb der Whitelist gelten als Vertragsbruch.
 */

/**
 * @typedef {'task.created'|'task.updated'|'agent.step.started'|'agent.failed'|'tool.executed'|'llm.completed'|'llm.failed'|'checkpoint.saved'} MeshEventType
 */

/**
 * @typedef {Object} MeshEvent
 * @property {string} id   Eindeutige Event-ID (UUID)
 * @property {MeshEventType} type
 * @property {number} at   Zeitstempel in Millisekunden
 * @property {number} [villaId]
 * @property {number|string} [taskId]
 * @property {number} [agentId]
 * @property {string} [status]
 * @property {string} [tool]
 * @property {boolean} [blocked]
 * @property {string} [code]
 * @property {number} [durationMs]
 * @property {number} [latencyMs]
 * @property {number} [tokensUsed]
 * @property {number} [costUsd]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [route]
 * @property {string} [checkpointId]
 * @property {number} [step]
 * @property {boolean} [processed]
 * @property {number} [open]
 * @property {string} [verification]
 */

/** Erlaubte Metadatenfelder - identisch zur SAFE_FIELDS-Whitelist in event-mesh.mjs. */
export const MESH_METADATA_FIELDS = Object.freeze([
  'villaId','taskId','agentId','status','tool','blocked','code','durationMs','latencyMs',
  'tokensUsed','costUsd','provider','model','route','checkpointId','step','processed','open','verification',
]);

/** Maximale Laenge fuer Textwerte im Event (Kuerzung passiert bereits in buildMeshEvent). */
export const MESH_TEXT_MAX = 160;

/**
 * Pflicht- und Optionalfelder je Event-Typ. Pflichtfelder sind das Minimum,
 * damit ein Consumer das Event sinnvoll einordnen kann.
 * @type {Record<string, {required: string[], optional: string[]}>}
 */
export const MESH_EVENT_CONTRACTS = Object.freeze({
  'task.created':      { required: ['villaId','taskId'], optional: ['agentId','status','step'] },
  'task.updated':      { required: ['villaId','taskId'], optional: ['agentId','status','durationMs','step'] },
  'agent.step.started':{ required: ['villaId'], optional: ['taskId','agentId','step','provider','model'] },
  'agent.failed':      { required: ['villaId'], optional: ['taskId','agentId','code','status','durationMs'] },
  'tool.executed':     { required: ['villaId','tool'],  optional: ['taskId','agentId','durationMs','blocked','status'] },
  'llm.completed':     { required: ['provider'],        optional: ['villaId','taskId','model','route','latencyMs','tokensUsed','costUsd','status'] },
  'llm.failed':        { required: ['code'],            optional: ['villaId','taskId','provider','route','latencyMs','status'] },
  'checkpoint.saved':  { required: ['checkpointId'],    optional: ['villaId','taskId','agentId','step','status','processed'] },
});

/** Alle gueltigen Event-Typen. */
export const MESH_EVENT_TYPES = Object.freeze(Object.keys(MESH_EVENT_CONTRACTS));

/**
 * Prueft ein Event gegen den Vertrag.
 * @param {any} event
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateMeshEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: ['event_must_be_object'] };
  }
  if (typeof event.id !== 'string' || !event.id) errors.push('id_missing');
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) errors.push('at_missing');
  if (typeof event.type !== 'string' || !MESH_EVENT_TYPES.includes(event.type)) {
    errors.push('type_unknown:' + String(event.type));
    return { ok: false, errors };
  }
  const contract = MESH_EVENT_CONTRACTS[event.type];
  for (const key of contract.required) {
    if (event[key] === undefined || event[key] === null) errors.push('required_missing:' + key);
  }
  const allowed = new Set(['id','type','at',...MESH_METADATA_FIELDS]);
  for (const key of Object.keys(event)) {
    if (!allowed.has(key)) errors.push('field_not_allowed:' + key);
  }
  for (const key of MESH_METADATA_FIELDS) {
    const value = event[key];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      if (value.length > MESH_TEXT_MAX) errors.push('text_too_long:' + key);
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      errors.push('field_type_invalid:' + key);
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      errors.push('field_not_finite:' + key);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Wirft bei Vertragsbruch - fuer Tests und strikte Emit-Pfade. */
export function assertMeshEvent(event) {
  const result = validateMeshEvent(event);
  if (!result.ok) throw new Error('Event verletzt Vertrag: ' + result.errors.join(', '));
  return event;
}

/**
 * Reduziert ein Live-Event (SSE-Strom) auf Metadaten.
 *
 * Hintergrund: `emit()` publiziert Rohdaten, inklusive Tool-Argumenten und
 * Dateiinhalten. Der SSE-Endpunkt braucht davon nichts - und darf ohne Anmeldung
 * keinesfalls Prompts, Code oder Modellantworten ausliefern. Diese Funktion ist
 * die Whitelist fuer den Stream und nutzt dieselben Felder wie der Mesh-Vertrag.
 *
 * @param {any} event
 * @returns {{type: string, ts: number} & Record<string, any>}
 */
export function sanitizeForStream(event) {
  const out = { type: String(event?.type || 'event').slice(0, 40), ts: Number(event?.ts) || Date.now() };
  if (!event || typeof event !== 'object') return out;
  for (const key of MESH_METADATA_FIELDS) {
    const value = event[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, MESH_TEXT_MAX);
  }
  return out;
}
