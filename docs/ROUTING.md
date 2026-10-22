# LLM-Routen: Betrieb und Diagnose

## Auswahlverhalten

- Routine-Rollen laufen lokal zuerst, sofern Ollama oder LM Studio erreichbar ist.
- `ROOT`, `CODER`, `ARCHITECT`, `REVIEWER` und `INTEGRATOR` nutzen Cloud-first und
  fallen bei Fehlern auf weitere freigegebene Provider und danach lokale Modelle zurück.
- `strategy: "LOCAL_FIRST"` und `strategy: "FALLBACK"` überschreiben die
  Rollenregel für einen einzelnen Aufruf.
- Fehlende Keys, Cooldowns, doppelte Endpoint-/Modellversuche und Providerfehler
  werden übersprungen. Das Cloud-Zeitbudget lässt Zeit für den lokalen Fallback.

## Kostenregel

`VF_LLM_FREE_ONLY=1` ist Standard. Erlaubt sind lokale Endpunkte, Gemini 3.1
Flash-Lite, unterstützte Groq-Free-Plan-Modelle und OpenRouter `openrouter/free`
oder explizite `:free`-Modelle. Kostenlose Cloud-Kontingente sind begrenzt und
garantieren keinen 24/7-Dienst. HF Inference Provider und Cerebras Testcredits gelten
nicht als dauerhaft kostenlos. Andere Routen benötigen `VF_LLM_FREE_ONLY=0` und
können Kosten auslösen.

Routen und Keys werden serverseitig über Umgebungsvariablen oder den Secrets-Store
konfiguriert. Secret-Werte erscheinen weder in Diagnoseausgaben noch in
Route-Statusantworten.

## Status und Test

- `GET /api/llm/status`: konfigurierte, kostenregelkonforme und nicht abgekühlte Routen.
- `GET /api/routes`: Route-Konfiguration; Keys werden nur als `hasKey`-Flag ausgegeben.
- `GET /api/keyforge`: erkannte Providerfamilie und letzte KeyForge-Aktionen.
- `node server/scripts/check-routing.mjs`: Kaskadenrouten synchronisieren und
  Bereitschaft anzeigen, ohne Modellaufruf.
- `node server/scripts/check-routing.mjs --probe`: sendet einen echten kurzen
  Modellaufruf. Das kann Providerkontingent verbrauchen; im Free-Only-Modus werden
  keine bezahlten oder kreditbasierten Routen ausgewählt.
- `npm test`: Offline-Tests für Reihenfolge, Kostenfilter, KeyForge-Autoverdrahtung,
  HTTP-Failover und Ausfallverhalten.

`eligible: true` bedeutet, dass Konfiguration, Kostenfilter und Cooldown passen.
Erst ein erfolgreicher Modellaufruf setzt den Status auf `recently_verified`.
Fehlende Keys und nicht erreichbare lokale Modelle benötigen Betreiberkonfiguration;
der Hub erzeugt keine Providerkonten oder API-Schlüssel.
