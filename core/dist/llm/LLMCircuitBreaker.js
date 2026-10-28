import axios from 'axios';
export var BreakerState;
(function (BreakerState) {
    BreakerState["CLOSED"] = "CLOSED";
    BreakerState["OPEN"] = "OPEN";
    BreakerState["HALF_OPEN"] = "HALF_OPEN";
})(BreakerState || (BreakerState = {}));
const defaultTransport = async (endpoint, body, headers, timeoutMs) => axios.post(endpoint, body, { headers, timeout: timeoutMs });
/**
 * Circuit-Breaker pro LLM-Provider: CLOSED -> OPEN bei Schwellwert oder 429,
 * HALF_OPEN nach Recovery-Zeit, Einzel-Probe, zurueck zu CLOSED bei Erfolg.
 * Der Transport ist injizierbar (Tests, eigene Fetch-Implementierungen).
 */
export class LLMCircuitBreaker {
    state = BreakerState.CLOSED;
    failureCount = 0;
    lastFailureTime = 0;
    failureThreshold;
    recoveryTimeMs;
    config;
    transport;
    constructor(config, failureThreshold = 3, recoveryTimeMs = 30_000, transport = defaultTransport) {
        this.config = config;
        this.failureThreshold = failureThreshold;
        this.recoveryTimeMs = recoveryTimeMs;
        this.transport = transport;
    }
    async execute(prompt, options) {
        if (this.state === BreakerState.OPEN) {
            if (Date.now() - this.lastFailureTime > this.recoveryTimeMs) {
                this.state = BreakerState.HALF_OPEN;
            }
            else {
                throw new Error(`Circuit OPEN for provider '${this.config.name}'`);
            }
        }
        try {
            const response = await this.transport(this.config.endpoint, { model: this.config.model, messages: [{ role: 'user', content: prompt }], ...options }, {
                'Content-Type': 'application/json',
                ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
            }, this.config.timeoutMs || 15_000);
            this.state = BreakerState.CLOSED;
            this.failureCount = 0;
            const data = response.data;
            return data.choices?.[0]?.message?.content || data.response || JSON.stringify(data);
        }
        catch (error) {
            this.failureCount++;
            this.lastFailureTime = Date.now();
            if (this.failureCount >= this.failureThreshold || error.response?.status === 429) {
                this.state = BreakerState.OPEN;
            }
            throw error;
        }
    }
    getState() {
        return this.state;
    }
    get providerName() {
        return this.config.name;
    }
}
//# sourceMappingURL=LLMCircuitBreaker.js.map