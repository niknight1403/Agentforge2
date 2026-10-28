import { Span } from '@opentelemetry/api';
/**
 * OpenTelemetry-Tracing fuer Agenten-Schritte. Initialisierung ist optional:
 * Ohne SDK ist der globale Tracer ein No-Op (produktionssicherer Fehlerton),
 * traceStep funktioniert dann trotzdem und wirft nur die Original-Fehler.
 */
export declare class AgentTelemetry {
    private static sdk;
    static init(collectorEndpoint?: string): Promise<boolean>;
    static traceStep<T>(stepName: string, attributes: Record<string, string | number>, fn: (span: Span) => Promise<T>): Promise<T>;
    static shutdown(): Promise<void>;
}
