import { trace, SpanStatusCode } from '@opentelemetry/api';
/**
 * OpenTelemetry-Tracing fuer Agenten-Schritte. Initialisierung ist optional:
 * Ohne SDK ist der globale Tracer ein No-Op (produktionssicherer Fehlerton),
 * traceStep funktioniert dann trotzdem und wirft nur die Original-Fehler.
 */
export class AgentTelemetry {
    static sdk = null;
    static async init(collectorEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces') {
        if (this.sdk)
            return true;
        // 'none' deaktiviert das SDK explizit (z. B. ohne Collector im Hub).
        if (collectorEndpoint === 'none' || process.env.OTEL_ENABLED === '0')
            return false;
        try {
            const [{ NodeSDK }, { OTLPTraceExporter }, { Resource }, { SemanticResourceAttributes }] = await Promise.all([
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
        }
        catch (err) {
            console.error('[AgentTelemetry] OTel-Init fehlgeschlagen (No-Op-Modus):', err?.message || err);
            return false;
        }
    }
    static async traceStep(stepName, attributes, fn) {
        const tracer = trace.getTracer('agentforge2-tracer');
        return tracer.startActiveSpan(stepName, { attributes }, async (span) => {
            try {
                const result = await fn(span);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            }
            catch (error) {
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                throw error;
            }
            finally {
                span.end();
            }
        });
    }
    static async shutdown() {
        if (this.sdk) {
            await this.sdk.shutdown().catch(() => undefined);
            this.sdk = null;
        }
    }
}
//# sourceMappingURL=AgentTelemetry.js.map