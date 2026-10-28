# Smart Resilience Router (Python-Pfad)

Hochverfügbares LLM-Routing mit Failover-Kette, Cooldowns und lokalem Fallback.

## Kette

| Priorität | Provider | Endpunkt | Key |
|---|---|---|---|
| 10 | Gemini Free | `generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |
| 20 | Groq Free | `api.groq.com/openai/v1` | `GROQ_API_KEY` |
| 30 | OpenRouter Free | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| 90 | Ollama Local | `http://localhost:11434/v1` | keiner (letzter Ausweg) |

## Fehlerklassen und Cooldowns

`classify_status()` ordnet jede Antwort einer Klasse zu:

- `RATE_LIMIT` (HTTP 429 ohne Quota-Hinweis) → Standard 120 s
- `QUOTA` (429/401/403 mit Quota-/Billing-Hinweis) → Standard 3600 s
- `SERVER_ERROR` (5xx, 401/403 ohne Quota-Bezug) → Standard 60 s
- `NETWORK` (Timeout, DNS, Verbindungsabbruch) → Standard 30 s

Der betroffene Provider wird für diese Dauer gesperrt, der nächste in der Kette
übernimmt sofort. Cooldowns laufen automatisch aus; ein erfolgreicher Aufruf
löscht einen bestehenden Cooldown des Providers.

Sind alle externen Provider gesperrt oder ohne Key, greift automatisch
`ollama-local`. Scheitert auch der, wirft der Router `AllProvidersFailed`
inklusive aller Versuche (`attempts`).

## Benutzung

```python
from resilience import build_router

router = build_router()                      # liest config/resilience_config.yaml
result = await router.complete(
    [{"role": "user", "content": "Status?"}], max_tokens=200
)
# result: text, provider, model, latency_ms, attempts[]
router.status()                              # Cooldowns, Latenzen, letzte Events
```

## Cog / Modul-Wrapper

`src/cogs/heinbot_resilience_cog.py` exportiert `HeinbotResilienceCog`.

- Ist `discord.py` installiert, ist es eine reguläre Cog (`cog_load`, `cog_unload`).
- Ohne `discord.py` arbeitet dieselbe Klasse als normales Modul mit `setup(registry)`
  bzw. `await setup_async()`.
- Keys werden aus `.env` gelesen (`load_env_file`), ohne bei fehlenden Keys zu blockieren:
  unkonfigurierte Provider werden lediglich übersprungen.

## Tests

```bash
python3 tests/test_resilience_router.py     # 9 Tests, ohne Netzwerkzugriff
```

## Abgrenzung zur Hub-Laufzeit

Der produktive AgentForge2-Hub ist ein Node.js-Dienst (`server/`, Kaskade in
`server/llm-cascade.mjs`, Routen in der `routes`-Tabelle). Dieses Modul ist der
Python-Pfad für Skripte, Coqs und Dienste, die dieselben Provider-Kontingente
nutzen sollen; es schreibt nicht in die Hub-Datenbank.
