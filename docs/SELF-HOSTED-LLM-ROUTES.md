# Oracle / Hetzner / Offline LLM-Routen

VillaForge registriert beim Serverstart zusaetzliche OpenAI-kompatible Routen, **nur wenn deren URL gesetzt ist**. Die vorhandene Kaskade prueft die Aktivierung, faellt bei Fehlern auf andere erreichbare Provider zurueck und respektiert ihre Zeitlimits.

## Server-Umgebung (niemals Geheimnisse ins Repository committen)

```dotenv
VF_LLM_ORACLE_URL=https://oracle-llm.example.internal/v1
VF_LLM_ORACLE_MODEL=qwen2.5:1.5b
# Optional, wenn der private Reverse-Proxy Bearer-Auth verlangt:
VF_LLM_ORACLE_API_KEY=

VF_LLM_HETZNER_URL=https://hetzner-llm.example.internal/v1
VF_LLM_HETZNER_MODEL=qwen2.5:1.5b
VF_LLM_HETZNER_API_KEY=

VF_LOCAL_LLM_URL=http://127.0.0.1:11434/v1
VF_LOCAL_LLM_MODEL=qwen2.5:1.5b
VF_LOCAL_LLM_SECONDARY_URL=http://127.0.0.1:1234/v1
```

Die Beispieladressen sind Platzhalter. Eigene, erlaubte Endpoint-Adressen ueber eine private Verbindung (VPN, Tailscale, WireGuard oder TLS-Reverse-Proxy mit Authentifizierung) bereitstellen. **Port 11434 nicht ungeschuetzt ins Internet oeffnen.** Ein gesetzter Endpunkt garantiert weder Erreichbarkeit noch kostenlosen Serverbetrieb. Externe Free-Tier-Anbieter haben Kontingente.

## Inbetriebnahme und Test

1. Modellserver auf Oracle/Hetzner/eigenem Rechner starten und sicher erreichbar machen; OpenAI-kompatibles `/v1/chat/completions` pruefen.
2. Endpoint- und Modellwerte sowie optionalen Key als Server-Umgebungsvariablen/Secrets konfigurieren; Server neu starten.
3. VillaForge-Route im Hub aktivieren und einen Testprompt absetzen; bei nicht erreichbarem Server die Failover-Meldungen pruefen.
4. Vor Produktivbetrieb Latenz, RAM/CPU-Grenzen, Authentifizierung, TLS, Logging ohne Geheimnisse und Wiederanlauf testen.

Nicht jede Ollama-Installation bedient den gewaehlten Modellnamen; vorab `ollama list` pruefen. Dieser Code erstellt keine Oracle-/Hetzner-VM, verteilt keine Keys und installiert keine Modelle automatisch.
