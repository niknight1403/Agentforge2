import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

export class AgentTelemetry {
  private static sdk: NodeSDK | null = null;
  static async init(endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318/v1/traces') {
    if (this.sdk) return;
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OTLP endpoint must use HTTP or HTTPS.');
    this.sdk = new NodeSDK({ resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'agentforge2-runtime' }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }) });
    await this.sdk.start();
  }
  static async shutdown() { if (this.sdk) { await this.sdk.shutdown(); this.sdk = null; } }
  static async traceStep<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T> {
    return trace.getTracer('agentforge2-runtime').startActiveSpan(name, { attributes }, async span => {
      try { const out = await fn(span); span.setStatus({ code: SpanStatusCode.OK }); return out; }
      catch (error) { span.recordException(error as Error); span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
      finally { span.end(); }
    });
  }
}
