/**
 * Katalog kostenlos nutzbarer, OpenAI-kompatibler LLM-Endpunkte.
 * Keys werden ausschliesslich aus Umgebungsvariablen oder dem Secrets-Store
 * gelesen, niemals im Code hinterlegt.
 */
export const FREE_ROUTE_CATALOG = [
  {
    // Stand 2026-10: gpt-oss-120b ist das staerkste Gratis-Modell bei Groq.
    // (llama-3.3-70b-versatile wurde dort abgeschafft.)
    name: 'Groq GPT-OSS 120B (free tier)',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keyEnv: 'GROQ_API_KEY',
    priority: 1
  },
  {
    name: 'Groq GPT-OSS 20B (free tier)',
    provider: 'groq-2',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-20b',
    keyEnv: 'GROQ_API_KEY',
    priority: 2
  },
  {
    name: 'Cerebras Llama 3.3 70B (free tier)',
    provider: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
    keyEnv: 'CEREBRAS_API_KEY',
    priority: 3
  },
  {
    name: 'Google Gemini 2.0 Flash (free tier)',
    provider: 'gemini-openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    keyEnv: 'GEMINI_API_KEY',
    priority: 4
  },
  {
    // Verifiziert 2026-10: :free-Variante existiert und antwortet
    // (Tageslimit 50 Gratis-Requests, Reset 02:00 MEZ).
    name: 'OpenRouter Gemma 4 31B (freie Modelle)',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-31b-it:free',
    keyEnv: 'OPENROUTER_API_KEY',
    priority: 5
  },
  {
    name: 'Mistral Small (free tier)',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    keyEnv: 'MISTRAL_API_KEY',
    priority: 6
  },
  {
    name: 'Together Llama 3.3 (free Modelle)',
    provider: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    keyEnv: 'TOGETHER_API_KEY',
    priority: 7
  },
  {
    name: 'Ollama lokal (kostenlos, offline)',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
    keyEnv: '',
    priority: 50
  }
];

/** Deterministischer Fallback, damit der Server ohne Keys lauffaehig bleibt. */
export const OFFLINE_ROUTE = {
  name: 'Offline-Planer (kein Key noetig)',
  provider: 'offline',
  baseUrl: '',
  model: 'villaforge-offline',
  keyEnv: '',
  priority: 999
};
