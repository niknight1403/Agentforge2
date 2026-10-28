import { trace, Span, SpanStatusCode } from '@opentelemetry/api';

/**
 * OpenTelemetry-Tracing fuer Agenten-Schritte. Initialisierung ist optional:
 * Ohne SDK ist der globale Tracer ein No-Op (produktionssicherer Fehlerton),
 * traceStep funktioniert dann trotzdem und wirft nur die Original-Fehler.
 */
export class AgentTelemetry {
  private static sdk: { shutdown: () => Promise<void> } | null = null;

  public static async init(
    collectorEndpoint: string = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces'
  ): Promise<boolean> {
    if (this.sdk) return true;
    // 'none' deaktiviert das SDK explizit (z. B. ohne Collector im Hub).
    if (collectorEndpoint === 'none' || process.env.OTEL_ENABLED === '0') return false;
    try {
      const [{ NodeSDK }, { OTLPTraceExporter }, { Resource }, { SemanticResourceAttributes }] =
        await Promise.all([
          import('@opentelemetry/sdk-node'),
          import('@opentelemetry/exporter-trace-otlp-http'),
          import('@opentelemetry/resources'),
          import('@opentelemetry/semantic-conventions'),
        ]);
      const sdk = new NodeSDK({
        resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: 'agentforge2-core' }),
        traceExporter: new OTLPTraceExporter({ url: collectorEndpoint }),
      });
      sdk.start();
      this.sdk = sdk;
      return true;
    } catch (err: any) {
      console.error('[AgentTelemetry] OTel-Init fehlgeschlagen (No-Op-Modus):', err?.message || err);
      return false;
    }
  }

  public static async traceStep<T>(
    stepName: string,
    attributes: Record<string, string | number>,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const tracer = trace.getTracer('agentforge2-tracer');
    return tracer.startActiveSpan(stepName, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: any) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  public static async shutdown(): Promise<void> {
    if (this.sdk) {
      await this.sdk.shutdown().catch(() => undefined);
      this.sdk = null;
    }
  }
}
