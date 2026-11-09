const RETRYABLE_CODES = new Set([
 'GENERATION_EVENT_PUBLISH_FAILED','GENERATION_REDIS_UNAVAILABLE','REDIS_UNAVAILABLE',
 'RATE_WINDOW_BUSY','CIRCUIT_OPEN','ECONNRESET','ECONNREFUSED','ETIMEDOUT',
 'EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT',
 'UND_ERR_SOCKET','GENERATION_PROVIDER_UNAVAILABLE','LLM_UNAVAILABLE'
]);

export function classifyGenerationFailure(error, attempt = 1, maxAttempts = 5) {
 const status = Number(error?.status ?? error?.statusCode ?? 0);
 const code = String(error?.code || '').toUpperCase();
 const retryable = error?.retryable === true || error?.busy === true ||
  status === 408 || status === 425 || status === 429 || status >= 500 ||
  RETRYABLE_CODES.has(code);
 return {
  code: String(error?.code || 'GENERATION_FAILED').slice(0, 100),
  retryable,
  terminal: !retryable || Number(attempt) >= Number(maxAttempts)
 };
}
