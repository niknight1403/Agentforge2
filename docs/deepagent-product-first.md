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

## Umgesetzt am 02.11.2026 (Code-Seite)

Das Gate ist nicht mehr nur Prompt-Text, sondern im Endpunkt erzwungen.

**Neue Bausteine**
- `server/deep-product-gate.mjs` — reine Bewertungslogik plus begrenzter Ordner-Scanner (max. 400 Dateien, 200 KB je Datei, `node_modules`/`.git`/`dist` ausgenommen).
- `server/tests/deep-product-gate.test.mjs` — 10 Faelle: leeres Projekt, belegtes Produkt, fehlender Verifikationslauf, fehlgeschlagener Build, Testdatei fehlt, Secrets im Projekt, duenne Spec, Kriterien als JSON und als Checkboxen, Scanner-Grenzen, fehlender Ordner.
- `server/tests/deep-product-gate-e2e.test.mjs` — 2 Faelle gegen den echten Hub: `POST /api/deep/projects/:id/develop` antwortet mit 409 und Blockern ohne Produkt; mit Belegen passiert die Anfrage das Gate.

**Verhalten**
- `POST /api/deep/projects/:id/develop` legt die Villa erst an, wenn das Gate besteht. Sonst `409` mit `gateBlocked: true`, `villaId: 0`, der Liste der Blockierte und `checks` je Pruefung.
- Geprueft werden: Quellcode (mind. 2 Dateien), Spec mit Inhalt, mind. 2 pruefbare Abnahmekriterien, Testdatei, README mit Startbefehl, keine Secret-Muster, aufgezeichneter Verifikationslauf (`verification.json` mit Build, Tests und Nutzerfluss auf `passed`).
- Unbekannt ist blockiert: fehlt ein Beleg, entsteht keine Villa.

**Verifikation**
- `npm test`: 428 Tests, 0 Fehler (vorher 426; die zwei neuen E2E-Faelle inklusive).
- `npm run check:syntax`: 190 Dateien gueltig.

**Bewusst offen**
- Ein belegter Verdrahtungslauf gegen ein echtes Modell (Villa-Erstellung nach bestandenem Gate) ist in CI nicht moeglich, weil dort keine Cloud-Keys gesetzt sind; der Test nennt in diesem Fall `LLM_UNAVAILABLE` statt Erfolg.
- Council-Scores und Minderheitenvoten werden weiterhin nicht persistiert (naechster Schritt).

## Rat: Rubrik und Minderheitenvoten persistiert (02.11.2026)

- Neue Spalten `council.scores` und `council.dissent` (Migration fuer bestehende Datenbanken in `server/db.mjs`).
- Neue Logik in `server/council-rubric.mjs`: Rubrik `nutzen`, `machbarkeit`, `belegbarkeit`, `differenzierung` (je 1-5, gewichtet 0.35/0.25/0.25/0.15) plus impact/effort wie bisher.
- `runCouncil()` speichert `scores` (inkl. `rated`-Status) und `dissent`; `listCouncil()` liefert beides mit.
- Minderheitenvoten nennen den Agenten, den Hebel, die schwaechste Dimension und den Grund, warum der Vorschlag liegen blieb (Schwelle 6).
- Ehrlichkeits-Fix: eine defekte Bewertungsantwort erzeugt **keine** neutralen 5/5-Werte mehr. Der Vorschlag laeuft als `rated: false` mit `score: null` weiter, bleibt als offenes Votum dokumentiert, und es entsteht trotzdem eine Aufgabe, damit die Villa nicht stillsteht.
- Bewertungen werden primaer ueber den Agentennamen zugeordnet, nicht ueber die Reihenfolge der Modellantwort.
- Tests: 10 Faelle fuer Rubrik/Auswertung, 3 Faelle fuer Persistenz (inkl. Alt-Test `council2` auf die ehrliche Erwartung umgestellt). Suite: 440 Tests gruen.

## Telemetrie: drei Kennzahlen sind jetzt messbar (02.11.2026)

Die Kennzahlen aus dem ursprünglichen Konzept standen bisher nur im Dokument. Jetzt liefert `server/telemetry.mjs` sie aus echten Daten:

- **build_green_rate** — Anteil Builds mit Status `ready` an allen protokollierten Builds. Ergebnisse landen in der neuen Tabelle `build_events` (Villa, Status, ok, Dauer, Abschlusszeit, Fehlertext), geschrieben am Ende jedes Builds in `server/builds.mjs`.
- **time_to_first_working** — Zeit von `villas.created_at` bis zum ersten gruenen Build: Median, p90, schnellste und langsamste Villa. Villen ohne gruenen Build zaehlen nicht mit und verfaelschen die Kennzahl nicht.
- **rework_quote** — Anteil Aufgaben mit Nacharbeit, gemessen an den vorhandenen Zaehlern `retry_count` und `assignments`.

Grundsaetze: Jede Kennzahl nennt ihre Stichprobe (`samples`). Ohne Daten ist der Wert `null`, nicht `0` — eine 0 waere eine Behauptung, die die Daten nicht tragen. `telemetrySummary()` liefert `complete: false` und einen `notes`-Eintrag, solange eine Kennzahl keine Daten hat.

Abruf: `GET /api/metrics/telemetry` (optional `?villaId=N`), angemeldet.

Nachweis: 10 Logiktests (`server/tests/telemetry.test.mjs`) und 3 E2E-Faelle gegen den Hub (`server/tests/telemetry-e2e.test.mjs`), Suite 452 Tests gruen.
