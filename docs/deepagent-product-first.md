# DeepAgent „Produkt zuerst, Villa danach" — Einordnung und Verdrahtung

Angepasster Prompt: `villa-prompts/deepagent-product-first-v1.md`.

## Warum diese Fassung

Der bestehende `PROMPT_CONTRACT` (`server/villa-configuration.mjs`) verlangt schon
einen Beleg je Aufgabe, aber die Reihenfolge „Produkt vor Villa" ist nirgends
verbindlich. `assessVillaConfiguration()` prüft `product.verified`, der Deep Agent
(`server/deepagent.mjs`) verknüpft Projekte über `deep_project_villas` mit einer
Villa, ohne dass ein Produkt-Gate dazwischen liegt. Genau diese Lücke schließt
der Prompt.

## Bausteine, auf denen der Prompt aufsetzt

| Baustein | Ort | Nutzung im Prompt |
|---|---|---|
| Rollen `PLANNER … PROFI` | `server/agent-roles.mjs` | Phasen und Zuständigkeiten |
| `PROMPT_CONTRACT` | `server/villa-configuration.mjs` | bleibt unverändert, wird ergänzt |
| `assessVillaConfiguration` | `server/villa-configuration.mjs` | Produkt-Gate, Delivery-Team, Werkzeuge |
| Council-Runden | `server/council.mjs` | Rat der Agenten, Abschnitt 6 |
| Deep-Projekt ↔ Villa | `server/deepagent.mjs` (`deep_project_villas`) | Villa erst nach Produkt-Gate |
| Produktreife | `server/product.mjs` (`maturity`, `proposalsToTasks`) | Phase 4 und 5 |

## Verdrahtung (Vorschlag, nicht Teil dieses Commits)

1. **Mission-Prompt:** `deepagent-product-first-v1.md` als Vorlage in die
   Missions-Prompt-Erzeugung aufnehmen (`kind='prompt_agent'`, Feld
   `mission_prompt`). Nutzeridee bleibt als `{{villa.idea}}` erhalten.
2. **Strukturierte Zusatzfelder:** `TASTE`-Profil und `SPION`-Matrix als
   Projektartefakte ablegen (`taste-profile.json`, `competitor-matrix.json`), damit
   Prompt-Kontext kurz bleibt und die Daten nachvollziehbar sind.
3. **Villa-Gate:** `linkDeepProjectVilla()` nur aufrufen, wenn
   `assessVillaConfiguration().checks` für `product_acceptance` und
   `development_tools` `pass` meldet. Sonst Status `PRODUCT_UNVERIFIED` mit
   konkreter Liste der fehlenden Belege.
4. **Council-Erweiterung:** Runde speichert zusätzlich `scores` (Nutzen,
   Machbarkeit, Belegbarkeit, Differenzierung) und `dissent`, damit Bewertungen
   später auswertbar sind.
5. **Kennzahlen:** `build_green_rate`, `test_pass_rate`, `time_to_first_working`,
   `rework_quote`, `vorschlag_trefferquote`, `spion_luecken_umgesetzt` als
   Telemetrie erfassen (nur Metadaten, keine Prompt-Inhalte).

## Abnahmekriterien der Umsetzung

- Eine Villa lässt sich ohne `product.verified === true` nicht an ein Deep-Projekt
  binden; die Fehlermeldung nennt die fehlenden Belege.
- Jede Council-Runde enthält Bewertungen und Minderheitenvoten.
- `TASTE`- und `SPION`-Artefakte sind Pflichtbestandteil der Villa-Übergabe.
- Kein Prompt-Inhalt, keine Nutzerdaten und keine Secrets in Telemetrie oder Logs.
