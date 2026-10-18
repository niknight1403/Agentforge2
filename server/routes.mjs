/**
 * Katalog kostenlos nutzbarer, OpenAI-kompatibler LLM-Endpunkte.
 * Keys werden ausschliesslich aus Umgebungsvariablen oder dem Secrets-Store
 * gelesen, niemals im Code hinterlegt.
 */
export const FREE_ROUTE_CATALOG = [
  {
    name: 'Groq Llama 3.3 70B (free tier)',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keyEnv: 'GROQ_API_KEY',
    priority: 1
  },
  {
    // Zweite Groq-Route: eigenes TPM-Budget pro Modell, verdoppelt die
    // freie Kapazitaet fuer den Agenten-Rat unter Last.
    name: 'Groq Qwen 3.8 27B (free tier)',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    keyEnv: 'GROQ_API_KEY',
    priority: 1
  },
  {
    name: 'Groq GPT-OSS 20B (free tier)',
    provider: 'groq',
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
    priority: 2
  },
  {
    name: 'Google Gemini 2.0 Flash (free tier)',
    provider: 'gemini-openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    keyEnv: 'GEMINI_API_KEY',
    priority: 3
  },
  {
    name: 'OpenRouter (freie Modelle)',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-31b-it:free',
    keyEnv: 'OPENROUTER_API_KEY',
    priority: 4
  },
  {
    // Fal.ai: OpenAI-kompatibler OpenRouter-Router — jede OpenRouter-Modell-ID
    // laeuft ueber einen Key. Auth-Header "Key" (nicht Bearer), siehe llm.mjs.
    name: 'Fal.ai OpenRouter (freie Modelle)',
    provider: 'fal',
    baseUrl: 'https://fal.run/openrouter/router/openai/v1',
    model: 'google/gemma-4-31b-it:free',
    keyEnv: 'FAL_KEY',
    priority: 4
  },
  {
    name: 'HuggingFace Router (free tier)',
    provider: 'huggingface',
    baseUrl: 'https://router.huggingface.co/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    keyEnv: 'HUGGINGFACE_API_KEY',
    priority: 4
  },
  {
    name: 'SambaNova Cloud (free tier)',
    provider: 'sambanova',
    baseUrl: 'https://api.sambanova.ai/v1',
    model: 'Meta-Llama-3.3-70B-Instruct',
    keyEnv: 'SAMBANOVA_API_KEY',
    priority: 5
  },
  {
    name: 'NVIDIA NIM (Gratis-Credits)',
    provider: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    keyEnv: 'NVIDIA_API_KEY',
    priority: 5
  },
  {
    name: 'Zhipu GLM-4-Flash (kostenlos)',
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyEnv: 'ZHIPU_API_KEY',
    priority: 6
  },
  {
    name: 'Chutes.ai (free tier)',
    provider: 'chutes',
    baseUrl: 'https://llm.chutes.ai/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    keyEnv: 'CHUTES_API_KEY',
    priority: 6
  },
  {
    name: 'Hyperbolic (free tier)',
    provider: 'hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    keyEnv: 'HYPERBOLIC_API_KEY',
    priority: 7
  },
  {
    name: 'Mistral Small (free tier)',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    keyEnv: 'MISTRAL_API_KEY',
    priority: 5
  },
  {
    name: 'Together Llama 3.3 (free Modelle)',
    provider: 'together',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    keyEnv: 'TOGETHER_API_KEY',
    priority: 6
  },
  {
    // Remote-GPU-Wrapper 1/2 — Modal Serverless GPU (OpenAI-kompatibel):
    // eigene Endpunkte (https://<workspace>--<app>.modal.run/v1) layern
    // rechenintensive Inferenz auf kostenlose/nachgelagerte GPU-Kapazitaet.
    name: 'Modal Serverless GPU (Remote-Worker)',
    provider: 'modal',
    baseUrl: process.env.MODAL_BASE_URL || '',
    model: process.env.MODAL_MODEL || 'gpt-oss-120b',
    keyEnv: 'MODAL_API_KEY',
    priority: 5
  },
  {
    // Remote-GPU-Wrapper 2/2 — Hugging Face Inference Providers
    // (OpenAI-kompatibler Router, freies Kontingent pro Konto/Monat):
    // Eigenstaendiger Inference-Providers-Dienst; kein ZeroGPU-Space.
    name: 'Hugging Face Inference Providers',
    provider: 'huggingface',
    baseUrl: 'https://router.huggingface.co/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    keyEnv: 'HF_TOKEN',
    priority: 6
  },
  {
    // Selbst gehostet auf Oracle Cloud Always Free (ARM, Frankfurt) —
    // unbegrenzt und kostenlos; DNS: ollama.cybersarah-ki.com
    name: 'Ollama Oracle Cloud (selbst gehostet, unbegrenzt)',
    provider: 'ollama',
    baseUrl: 'https://ollama.cybersarah-ki.com/v1',
    model: 'llama3.2:3b',
    keyEnv: 'OLLAMA_API_KEY',
    priority: 7
  },
  {
    name: 'Ollama lokal (kostenlos, offline)',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2:3b',
    keyEnv: '',
    priority: 30
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
