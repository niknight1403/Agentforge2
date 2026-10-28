import { randomBytes } from 'node:crypto';

// OTLP/HTTP JSON exporter using Node's built-in fetch. It keeps the Hub
// dependency-free while emitting standard OpenTelemetry trace spans.
const endpoint = () => String(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${String(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).replace(/\/+$/, '')}/v1/traces` : '')).trim();
const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();
const safeAttrs = attrs => Object.entries(attrs || {}).filter(([k,v]) => /^[a-zA-Z0-9_.-]{1,64}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
  .map(([key,value]) => ({ key, value: typeof value === 'string' ? { stringValue: value.slice(0,160) } : typeof value === 'boolean' ? { boolValue: value } : { intValue: Math.trunc(value) } }));

/** Export one metadata-only OTel span. Export failures never fail agent work. */
export async function exportOtelSpan(name, attributes = {}, { startedAt = Date.now(), statusCode = 1 } = {}) {
  const target = endpoint();
  if (!target) return false;
  try {
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const start = (BigInt(Math.max(0, Math.trunc(startedAt))) * 1_000_000n).toString();
    const end = nowNs();
    const response = await fetch(target, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: safeAttrs({ 'service.name': process.env.OTEL_SERVICE_NAME || 'agentforge2', 'service.version': process.env.npm_package_version || 'unknown' }) }, scopeSpans: [{ scope: { name: 'agentforge2' }, spans: [{ traceId, spanId, name: String(name).slice(0,128), kind: 3, startTimeUnixNano: start, endTimeUnixNano: end, attributes: safeAttrs(attributes), status: { code: statusCode } }] }] }] }),
      signal: AbortSignal.timeout(1500)
    });
    return response.ok;
  } catch { return false; }
}

/** Instrument a bounded operation without allowing tracing to change its result. */
export async function withOtelSpan(name, attributes, fn) {
  const startedAt = Date.now();
  let statusCode = 1;
  try { return await fn(); }
  catch (error) { statusCode = 2; throw error; }
  finally { void exportOtelSpan(name, attributes, { startedAt, statusCode }); }
}
