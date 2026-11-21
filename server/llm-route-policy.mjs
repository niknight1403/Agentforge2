const PROVIDERS = Object.freeze({
  groq: { hosts: ['api.groq.com'], keyEnvs: ['GROQ_API_KEY'] },
  cerebras: { hosts: ['api.cerebras.ai'], keyEnvs: ['CEREBRAS_API_KEY'] },
  gemini: { hosts: ['generativelanguage.googleapis.com'], keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  'gemini-openai': { hosts: ['generativelanguage.googleapis.com'], keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  mistral: { hosts: ['api.mistral.ai'], keyEnvs: ['MISTRAL_API_KEY'] },
  openrouter: { hosts: ['openrouter.ai'], keyEnvs: ['OPENROUTER_API_KEY'] },
  huggingface: { hosts: ['router.huggingface.co'], keyEnvs: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'] },
  xai: { hosts: ['api.x.ai'], keyEnvs: ['XAI_API_KEY'] },
  fal: { hosts: ['fal.run'], keyEnvs: ['FAL_KEY'] },
  sambanova: { hosts: ['api.sambanova.ai'], keyEnvs: ['SAMBANOVA_API_KEY'] },
  nvidia: { hosts: ['integrate.api.nvidia.com'], keyEnvs: ['NVIDIA_API_KEY'] },
  zhipu: { hosts: ['open.bigmodel.cn'], keyEnvs: ['ZHIPU_API_KEY'] },
  chutes: { hosts: ['llm.chutes.ai'], keyEnvs: ['CHUTES_API_KEY'] },
  hyperbolic: { hosts: ['api.hyperbolic.xyz'], keyEnvs: ['HYPERBOLIC_API_KEY'] },
  together: { hosts: ['api.together.xyz'], keyEnvs: ['TOGETHER_API_KEY'] },
  modal: { hosts: [], keyEnvs: ['MODAL_API_KEY'] },
  ollama: { hosts: ['ollama.cybersarah-ki.com'], keyEnvs: ['OLLAMA_API_KEY'] },
  lmstudio: { hosts: [], keyEnvs: [] }
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function validateLlmRouteInput(input = {}) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const policy = PROVIDERS[provider];
  if (!policy) return { ok: false, error: 'PROVIDER_NOT_ALLOWED' };

  const raw = String(input.baseUrl || '').trim();
  if (!raw || raw.length > 2048) return { ok: false, error: 'ENDPOINT_INVALID' };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, error: 'ENDPOINT_INVALID' }; }
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: 'ENDPOINT_INVALID' };

  const host = url.hostname.toLowerCase();
  const local = ['ollama', 'lmstudio'].includes(provider) && LOOPBACK.has(host);
  if (local) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'ENDPOINT_NOT_ALLOWED' };
  } else {
    if (url.protocol !== 'https:' || !policy.hosts.includes(host)) return { ok: false, error: 'ENDPOINT_NOT_ALLOWED' };
  }

  const keyEnv = String(input.keyEnv || '').trim();
  if (keyEnv && !policy.keyEnvs.includes(keyEnv)) return { ok: false, error: 'KEY_ENV_NOT_ALLOWED' };
  if (provider === 'lmstudio' && keyEnv) return { ok: false, error: 'KEY_ENV_NOT_ALLOWED' };

  const path = url.pathname.replace(/\/+$/, '');
  const allowedPaths = {
    groq: ['/openai/v1', '/v1'], cerebras: ['/v1'], gemini: ['/v1beta/openai'],
    'gemini-openai': ['/v1beta/openai'], mistral: ['/v1'], openrouter: ['/api/v1'],
    huggingface: ['/v1'], xai: ['/v1'], fal: ['/openrouter/router/openai/v1'],
    sambanova: ['/v1'], nvidia: ['/v1'], zhipu: ['/api/paas/v4'],
    chutes: ['/v1'], hyperbolic: ['/v1'], together: ['/v1'],
    ollama: ['/v1'], lmstudio: ['/v1']
  };
  if (provider !== 'modal' && !(allowedPaths[provider] || []).includes(path)) return { ok: false, error: 'ENDPOINT_PATH_NOT_ALLOWED' };
  if (provider === 'modal') return { ok: false, error: 'CUSTOM_MODAL_ENDPOINT_REQUIRES_DEPLOYMENT_APPROVAL' };

  return { ok: true, provider, baseUrl: url.toString().replace(/\/$/, ''), keyEnv };
}
