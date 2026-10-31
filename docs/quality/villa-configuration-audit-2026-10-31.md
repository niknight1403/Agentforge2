# Villa-Konfiguration und Integrationen

## Umfang und Nachweis

Aktueller Ausgangs-Head: `cdff83ff7f5057c5ef5aba62174fa1da203d4699`, Hub-Version 1.60.5. Keine AGENTS.md im aktuellen Repository-Tree vorhanden. Produktionsinventar ueber den vorhandenen Administrator-Login und GitHub Secrets gelesen, keine Schluessel ausgelesen.

[Produktionsaudit](https://github.com/niknight1403/Agentforge2/actions/runs/41247629493): alle 16 Villen erfasst, kein HTTP-Fixture, keine Projektstarts und keine Modellaufrufe. Alle 16 sind wegen fehlender Produktabnahme blockiert; dies ist keine Aussage, dass alle Konfigurationsschalter defekt sind.

## Einzelbefunde

| Villa | Laufzustand | Agenten | Offene Aufgaben | Produktabnahme |
|---|---|---:|---:|---|
| 31 | RUNNING | 11 | 23 | nicht belegt |
| 34 | WAITING_FOR_MODEL | 13 | 38 | nicht belegt |
| 29 | WAITING_FOR_MODEL | 1 | 12 | nicht belegt |
| 25 | COMPLETED | 13 | 0 | nicht belegt |
| 24 | RUNNING | 13 | 27 | nicht belegt |
| 18 | RUNNING | 13 | 3 | nicht belegt |
| 17 | RUNNING | 31 | 15 | nicht belegt |
| 12 | WAITING_FOR_MODEL | 13 | 1 | nicht belegt |
| 10 | RUNNING | 16 | 2 | nicht belegt |
| 9 | WAITING_FOR_MODEL | 49 | 26 | nicht belegt |
| 8 | WAITING_FOR_MODEL | 49 | 1 | nicht belegt |
| 5 | COMPLETED | 13 | 0 | nicht belegt |
| 4 | RUNNING | 13 | 23 | nicht belegt |
| 3 | WAITING_FOR_MODEL | 13 | 11 | nicht belegt |
| 2 | RUNNING | 25 | 22 | nicht belegt |
| 1 | RUNNING | 25 | 79 | nicht belegt |

13 Werkzeug-Packs und acht Standardskills sind aktiv. Keine eigenen Connectoren konfiguriert. 24 Modellrouten waren konfiguriert, 12 zu diesem Zeitpunkt laut Status nutzbar; eine echte Modellantwort wurde durch diesen lesenden Audit nicht angefordert. Aktiviert bedeutet weder credential-ready noch erfolgreich ausgefuehrt.

## Behobene Quellcode-Luecken

1. Kompakte Tool-Prompts verloren alle Argumente der bestehenden flachen Schemas. Dateipfad, Inhalt, Patch-Parameter und Typen bleiben nun erhalten; gesperrte Tools werden nicht angeboten.
2. `refreshAgentPrompts()` ueberschrieb jeden individuellen Agenten-Prompt. Neue Hash-Provenienz migriert nur bekannte verwaltete Vorlagen. Eigene Prompts bleiben bytegenau erhalten; ein Vier-Teil-Vertrag wird im Laufzeitkontext ergaenzt. Unbekannte Altvorlagen werden bewusst nicht erraten oder ersetzt.
3. Rohidee und strukturierter Missionsvorschlag waren nicht konsistent mit dem ausfuehrenden Agenten verbunden. Jede Villa bekommt nun ihren eigenen, begrenzten Auftrag im Kontext. Vorschlaege sind Nutzerdaten, keine neuen Systemrechte.
4. `project_write`, `project_patch` und `artifact_patch` umgingen ihre vorgesehenen Pack-Schalter. Die Zuordnung ist geschlossen und mit echten `runTool`-Aufrufen getestet.
5. Der geplante Prompt-Agent betrieb eine separate IP-/Modellkaskade mit 600-Sekunden-Timeout und legte neue Tasks ohne Abnahme an. Er verwendet nun die bestehende Hub-Kaskade mit begrenztem Gesamtbudget und erzeugt nur schema-validierte, idempotente Missionsvorschlaege. Originalidee, Vision, Start/Stop und Aufgaben bleiben erhalten.
6. Neuer Admin-Endpunkt `GET /api/admin/villa-diagnostics`: regelbasierte Pruefung fuer alle Villen, Abnahme getrennt vom Laufstatus, ohne Rohprompts und Schluessel. HTTP-Tests sichern 401/403 und Adminzugriff.

7. Der stuendliche Mission-Treiber startete aus dem Ranking auch pausierte Villen und rief einen nicht vorhandenen retry-failed-Endpunkt auf. Planmaessiger Modus beobachtet jetzt nur; bewusste manuelle Starts gehen weiter ueber denselben Hub-Scheduler. Nutzereingaben werden als Umgebungsdaten statt Shell-Code uebergeben. Verhaltenstests simulieren pausierte Villen, explizite Mehrfachstarts und ungueltige Eingaben.

## Betrieb, Grenzen und Rueckfall

- Vorhandene Architektur, Datenbank, Scheduler und Providerregister bleiben bestehen. Es wird kein zusaetzlicher Autopilot gestartet.
- Neues SQLite-Metadatenobjekt `agent_prompt_templates` speichert nur Hashes. Keine vorhandene Tabelle oder Nutzervorgabe wird geloescht.
- Der Missionsgenerator prueft vor Schreiben die gelesene Originalidee/Version erneut; konkurrierende Aenderungen werden nicht ueberschrieben. Maximal drei Villen je planmaessigem Lauf; jede Modellanfrage ist auf 60 Sekunden begrenzt.
- Eine fehlende Faehigkeit wird als Integrationsbedarf gemeldet, nicht durch einen neuen bezahlten Provider verdeckt. Medienkonfiguration braucht ihren eigenen Render- und Rechte-Nachweis.
- Rollback: konkreten PR-Commit revertieren; keine Fremdaenderungen per reset --hard verwerfen. Die Hash-Tabelle darf bestehen bleiben.
- Zwei als COMPLETED markierte Villen (5 und 25) haben keinen Produktnachweis. Kein automatisches Wiederstarten oder Loeschen im Rahmen dieses Audits.
- Der Audit-Workflow darf bei offenen Produktblockern mit Exit 1 enden; sein JSON-Bericht unterscheidet dies von einem unvollstaendigen Audit.

## Nachpruefung

`npm run check` prueft Syntax, Secrets, Tests und Web-Build. Der bestehende Browserworkflow prueft die bedienbare Oberflaeche mit Fixtures. Der Produktionsaudit prueft reale Metadaten. Keiner dieser Befunde ersetzt eine echte produktbezogene Endabnahme.
