import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportOtelSpan, withOtelSpan } from '../otel.mjs';

test('OTLP exporter emits bounded metadata spans and keeps failures off the agent path', async () => {
  const oldEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const oldBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const oldFetch = globalThis.fetch;
  let sent;
  try {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    globalThis.fetch = async (url, options) => { sent = { url, body: JSON.parse(options.body) }; return new Response('', { status: 200 }); };
    assert.equal(await exportOtelSpan('agent.tool.execute', { 'agent.tool': 'code_write', 'agent.id': 8, args: { token: 'never-export' } }), true);
    const span = sent.body.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(sent.url, 'http://127.0.0.1:4318/v1/traces');
    assert.equal(span.name, 'agent.tool.execute');
    assert.ok(span.traceId.length === 32 && span.spanId.length === 16);
    assert.deepEqual(span.attributes.map(a => a.key), ['agent.tool', 'agent.id']);
    assert.equal(JSON.stringify(sent.body).includes('never-export'), false);
    globalThis.fetch = async () => { throw new Error('collector offline'); };
    assert.equal(await withOtelSpan('agent.step', {}, async () => 'work continues'), 'work continues');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT; else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = oldEndpoint;
    if (oldBase === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = oldBase;
  }
});
