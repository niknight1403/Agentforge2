/**
 * LLM-Kette fuer AnfragePilot.
 *
 * Reihenfolge: Groq -> OpenAI -> Gemini -> Ollama (lokal).
 * Jede Route wird nur versucht, wenn ein Endpunkt konfiguriert ist. Ist keine
 * Route erreichbar, wirft der Aufruf einen Fehler mit Code LLM_UNAVAILABLE —
 * es gibt bewusst keinen stillen Platzhalter-Text.
 */

/**
 * Jede Route fuehrt eine geordnete Modellliste. Verschwindet ein Modell beim
 * Anbieter (kommt bei Groq regelmaessig vor), rutscht die Route automatisch
 * auf das naechste Modell statt komplett auszufallen.
 */
const ROUTEN = [
  {
    name: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelle: () => [
      process.env.GROQ_MODEL,
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
    ].filter(Boolean),
    key: () => process.env.GROQ_API_KEY,
  },
  {
    name: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    modelle: () => [process.env.OPENAI_MODEL, "gpt-4o-mini", "gpt-4.1-mini"].filter(Boolean),
    key: () => process.env.OPENAI_API_KEY,
  },
  {
    name: "gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelle: () => [process.env.GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-2.5-flash-lite"].filter(Boolean),
    key: () => process.env.GEMINI_API_KEY,
  },
  {
    name: "ollama",
    url: (process.env.OLLAMA_URL || "http://127.0.0.1:11434") + "/v1/chat/completions",
    modelle: () => [process.env.OLLAMA_MODEL, "llama3.2:3b", "qwen2.5:3b"].filter(Boolean),
    key: () => "ollama",
  },
];

// Zuletzt bewaehrtes Modell je Route: spart bei jedem Aufruf die Fehlversuche.
const bewaehrt = new Map();

export class LlmFehler extends Error {
  constructor(message, code = "LLM_UNAVAILABLE") {
    super(message);
    this.code = code;
  }
}

async function frageRoute(route, messages, { timeoutMs = 25000, temperature = 0.3 } = {}) {
  const key = route.key();
  if (!key) throw new LlmFehler(`${route.name}: kein Zugang konfiguriert`);
  const gemerkt = bewaehrt.get(route.name);
  const modelle = gemerkt ? [gemerkt, ...route.modelle().filter((m) => m !== gemerkt)] : route.modelle();
  let letzterFehler = null;
  for (const model of modelle) {
    try {
      const ergebnis = await rufeModell(route, model, key, messages, { timeoutMs, temperature });
      bewaehrt.set(route.name, model);
      return ergebnis;
    } catch (e) {
      letzterFehler = e;
      // Nur bei unbekanntem Modell weiterschalten, sonst Route abbrechen.
      if (!/model_not_found|does not exist|HTTP 404|HTTP 400/i.test(e.message)) break;
    }
  }
  throw letzterFehler;
}

async function rufeModell(route, model, key, messages, { timeoutMs, temperature }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(route.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: 900 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new LlmFehler(`${route.name}: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    const inhalt = data?.choices?.[0]?.message?.content;
    if (!inhalt || !String(inhalt).trim()) throw new LlmFehler(`${route.name}: leere Antwort`);
    return { inhalt: String(inhalt), provider: `${route.name}:${model}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ruft die erste funktionierende Route auf. `aufruf` ist injizierbar, damit
 * Tests ohne Netz laufen koennen.
 */
export async function llmChat(messages, optionen = {}, aufruf = frageRoute) {
  const fehler = [];
  for (const route of ROUTEN) {
    if (!route.key()) continue;
    try {
      return await aufruf(route, messages, optionen);
    } catch (e) {
      fehler.push(`${route.name}: ${e.message}`);
    }
  }
  throw new LlmFehler(
    fehler.length ? `Keine LLM-Route erreichbar (${fehler.join(" | ")})` : "Kein LLM konfiguriert (GROQ_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY setzen)"
  );
}
