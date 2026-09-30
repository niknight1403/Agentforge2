# VillaForge

VillaForge ist ein privates System zum Erstellen von **Deep Agents**, die eine Idee in einer
**Villa mit bis zu 1000 Agenten** autonom planen, umsetzen und abschließen.

Beim Anlegen einer Villa öffnet sich automatisch das Chat-Fenster mit dem Deep Agent.
Ein Router rotiert über **kostenlose LLM-Anbindungen** und wechselt bei Fehlern automatisch
auf die nächste Route. Ohne hinterlegten Key arbeitet ein regelbasierter Offline-Planer, damit
das System immer lauffähig bleibt.

## Bestandteile

| Teil | Pfad | Status |
| --- | --- | --- |
| VillaForge Hub (Server + Web-UI) | `server/` | fertig, lauffähig, getestet |
| Android-App (Kotlin/Compose) | `app/` | fertig: Villa-Ansicht, Deep-Agent-Chat, SSE-Live-Ereignisse |

## Hub starten

```bash
node server/server.mjs          # Standard-Port 12000
PORT=12001 node server/server.mjs
```

Danach im Browser öffnen: `http://localhost:12000/`

- Health: `GET /api/health`
- Oberfläche: `/`
- Ereignisstrom (SSE): `/api/events`

Der Server benötigt **keine** externen Abhängigkeiten (`npm install` entfällt). Er nutzt die
Module `node:sqlite`, `fetch` und `EventEmitter`.

> **Hinweis zu Node-Versionen:** Ab Node 23.4 läuft der Hub direkt. Unter Node 22.x ist
> `node:sqlite` noch experimentell — starte dort mit
> `node --experimental-sqlite server/server.mjs`.

### Hintergrundbetrieb (Daemon)

Damit die Entwicklung weiterläuft, wenn das Terminal geschlossen wird:

```bash
bash scripts/daemon.sh start     # startet im Hintergrund, schreibt server/data/hub.log
bash scripts/daemon.sh status    # PID und Health
bash scripts/daemon.sh logs      # Log verfolgen
bash scripts/daemon.sh stop      # sauber beenden (SIGTERM)
```

PID liegt in `server/data/hub.pid`, Log in `server/data/hub.log`.

**Wiederaufnahme:** Beim Start prüft der Hub, ob eine Villa noch auf `RUNNING` steht. Das
kann nur passieren, wenn der Prozess abgebrochen wurde. Solche Läufe werden automatisch
fortgesetzt, sofern die Autonomie der Villa nicht abgeschaltet ist (`autonomy = 0`).
Aufgaben, die beim Abbruch auf `RUNNING` standen, werden wieder auf `PENDING` gesetzt und
erneut ausgeführt. Abschalten mit `VF_RESUME=0`.

## Funktionsumfang

- **Villa anlegen**: Idee eingeben, Deep Agent erzeugen, Plan ableiten, Agentenpool aufbauen.
- **Automatischer Chat**: Nach dem Erstellen öffnet sich das Chat-Fenster zum Deep Agent.
- **Start und Stop**: Ein Knopf startet die Entwicklung, ein zweiter beendet sie. Der Stopp
  greift nach dem laufenden Aufgabenschritt und setzt die Villa auf `PAUSED`.
- **1000-Agenten-Villa**: Rollen (Planner, Researcher, Architect, Coder, Reviewer, Tester,
  Documenter, Critic, Integrator, Worker), hart begrenzt über `max_agents`.
- **Autonome Ausführung**: `POST /api/villas/:id/orchestrate` arbeitet offene Aufgaben
  parallel ab (Standard 4 gleichzeitig) und führt passende Aufgaben der Rolle zuerst aus.
- **Selbstheilende Planung**: Sind alle Aufgaben erledigt, prüft der Deep Agent den
  Gesamtstand und legt fehlende Aufgaben nach. Die Zahl der Runden ist begrenzt
  (`maxRounds`, Standard 6) und wird in der Villa gespeichert, damit der Lauf garantiert
  endet und ein Neustart nicht wieder bei null beginnt.
- **Gedächtnis**: Einträge mit Art (`FACT`, `DECISION`, `ARTIFACT`, `LESSON`, `IDEA`,
  `CONSTRAINT`) und Wichtigkeit; fließen in jeden Agenten-Prompt ein.
- **Werkzeuge**: `memory_write`, `memory_search`, `web_fetch`, `task_create`, `task_update`,
  `agent_spawn`, `artifact_write`, `artifact_list`, `report_write`, `project_summary`,
  `project_search`, `project_read`, `project_run` – jeder Aufruf wird auditiert.
- **Bestehende App analysieren**: Wird beim Erstellen ein Quellpfad angegeben, liest der
  Deep Agent den echten Code (Dateien, Sprachen, wichtige Dateien, Paketbefehle), schreibt
  einen Analysebericht und entscheidet zwischen `REBUILD` (sauberer Neubau) und `OPTIMIZE`
  (gezielt verbessern). Der Plan enthält dann zusätzlich die Rollen `BUSINESS` und `GROWTH`.
- **Umsatzfokus**: Die Rollen `BUSINESS` (Geschäftsmodell, Preis, Marge) und `GROWTH`
  (Akquise, Aktivierung, Bindung) liefern konkrete, prüfbare Schritte statt Absichtserklärungen.
- **Verifikation**: Nach dem letzten Aufgabenschritt baut und testet der Hub das Projekt
  wirklich (`npm run build`, `npm test`, `gradle test`). Das Ergebnis steht als Bericht
  „Verifikation bestanden“ bzw. mit Fehlerdetails vor. Schlägt der Build fehl, bleibt die
  Villa auf `PAUSED` und es entstehen Reparaturaufgaben.
- **Berichte**: Analyse- und Verifikationsberichte sind in App (Abschnitt „Berichte“) und
  Web-Oberfläche (Tab „Berichte“) einsehbar.
- **LLM-Routen-Rotator**: Priorität plus Rotation, Failover bei Fehler, Statistik je Route.
  Eine fehlgeschlagene Route wird für 60 Sekunden gesperrt (nach weiteren Fehlern länger,
  höchstens 10 Minuten). Das verhindert, dass jeder Aufruf erneut in dieselbe tote Route läuft.
- **Secrets**: API-Keys liegen nur serverseitig in der Datenbank und werden nie angezeigt.

## Kostenlose LLM-Routen (Katalog)

Vorkonfiguriert sind OpenAI-kompatible Endpunkte mit kostenlosem Kontingent:
Groq, Cerebras, Google Gemini, OpenRouter (freie Modelle), Mistral, Together sowie
lokales Ollama. Key-Namen: `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`.

Key hinterlegen – entweder als Umgebungsvariable beim Start oder in der Oberfläche unter
„API-Key hinterlegen“. Es genügt **ein** Key; der Router nutzt alle aktiven Routen.

## API-Kurzreferenz

```
GET    /api/health
GET    /api/villas
POST   /api/villas                    { name, idea, agentCount, sourcePath? }
GET    /api/villas/:id                Villa, Agenten, Aufgaben, Gedächtnis, Berichte, Audit
POST   /api/villas/:id/source         { path } – Quellprojekt hinterlegen
POST   /api/villas/:id/analyze        Projekt analysieren, Bericht + REBUILD/OPTIMIZE
GET    /api/villas/:id/reports        Analyse- und Verifikationsberichte
POST   /api/villas/:id/orchestrate    { concurrency, maxTasks, adaptive } – Entwicklung starten
POST   /api/villas/:id/stop           Entwicklung stoppen
GET    /api/villas/:id/messages?agentId=
POST   /api/villas/:id/chat           { message, agentId }
POST   /api/agents/:id/chat           { message }
GET    /api/routes
POST   /api/routes                    { name, provider, baseUrl, model, keyEnv, priority }
PATCH  /api/routes/:id                { enabled, priority }
GET    /api/secrets                   nur Namen
POST   /api/secrets                   { name, value }
GET    /api/tools
GET    /api/events                    Server-Sent Events
```

## Android-App (`app/`)

Dünner Client gegen den Hub. Enthalten: Compose-Oberfläche (Villen-Liste, Erstellen mit
optionalem Quellpfad, Detail mit Start/Stop und Berichte-Bereich, Chat, Einstellungen),
HTTP-Client über OkHttp, Chat mit gerenderten Abschnitten und Listen,
Fortschritts-Aktualisierung während eines Laufs.

Die APK liegt fertig unter `VillaForge.apk` im Projektwurzelverzeichnis und wird mit

```bash
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=$HOME/android-sdk \
  $HOME/gradle-8.7/bin/gradle :app:assembleDebug
```

neu gebaut. Die Hub-Adresse ist in der App unter Einstellungen änderbar; der Standardwert
zeigt auf die Runtime-URL des Hubs. Die gesamte Agenten-, LLM- und Werkzeuglogik läuft im
Hub – die App überträgt nur Ein- und Ausgaben und speichert keine API-Keys auf dem Gerät.

## Sicherheit

- Keine Keys im Quelltext und nicht in der Versionsverwaltung.
- API-Keys werden nur serverseitig gespeichert und nie ausgeliefert.
- Werkzeugaufrufe laufen über eine Whitelist und werden mit Ergebnis auditiert.
- Befehlsausführung ist eng begrenzt: erlaubt sind nur `npm run|test`, `gradle test|build`
  und Skriptdateien aus dem Projekt. `npm install`, `npx`, Inline-Code (`-e`/`-c`),
  Shell-Verkettung und Netzwerkargumente sind gesperrt, damit Agenten bauen und testen,
  aber keine fremde Software nachladen können.
- Dateizugriffe sind auf den Projektordner begrenzt; `..`-Ausbrüche und absolute Pfade
  außerhalb werden abgewiesen.
- `web_fetch` akzeptiert ausschließlich `http`/`https`.
- Die App bleibt privat: keine Telemetrie, kein externer Dienst außer den selbst
  konfigurierten LLM-Endpunkten.

## Grenzen (bewusst nicht enthalten)

Diese Punkte sind absichtlich nicht umgesetzt, weil sie dem Sicherheitsmodell
widersprechen oder keinen Nutzen bringen:

- **Keine unbegrenzte Autonomie.** Jeder Lauf ist durch `maxTasks` und `maxRounds`
  begrenzt. Eine Schleife ohne Ende verbraucht nur Zeit und Kontingent.
- **Kein Selbstnachladen von Abhängigkeiten.** `npm install`, `npx`, Inline-Code und
  Shell-Verkettung sind gesperrt. Ein Agent, der sich selbst Werkzeuge nachlädt, hebelt
  jede Kontrolle über den Rechner aus.
- **Werkzeuge sind eine feste Whitelist** (`TOOL_SPECS`), kein selbst erweiterbarer Baum.
  Neue Werkzeuge werden im Code ergänzt und geprüft, nicht zur Laufzeit erzeugt.
- **Kein lokales Modell vorinstalliert.** Die Ollama-Route ist im Katalog vorhanden, aber
  Ollama ist nicht installiert und kein Modell geladen. Ohne Key arbeitet der
  regelbasierte Offline-Planer.

## Android-App

Kotlin/Compose-App gegen dieselbe Hub-API wie die Web-Oberfläche. Alle drei Bereiche
sind fertig und live getestet (Villa-Ansicht, Deep-Agent-Chat, SSE):

- **Villa-Ansicht** — Liste, Erstellen (inkl. Projektanalyse-Modus), Detail mit
  Status, Aufgaben, Agenten, Gedächtnis und Berichten.
- **Chat mit dem Deep Agent** — Verlauf je Root-Agent, Senden mit optimistischer
  Anzeige, Antworten werden als Abschnitte/Listen aufbereitet gerendert
  (Rich-Text-Parser für `##`/`-`/`1.`).
- **SSE-Live-Ereignisse** — `GET /api/events` wird per eigener Event-Stream-Verbindung
  gelesen (`net/SseClient.kt`): automatisches Nachverbinden mit Backoff
  (1–15 s), Puls-Indikator in der Kopfzeile, Live-Ereignis-Feed in der Detail-Ansicht
  und Ereignis-Ticker im Chat. Events für die offene Villa aktualisieren die Detaildaten
  automatisch (debounced), ohne das 4-Sekunden-Polling ersetzen zu müssen.

Hub-Adresse ist in den Einstellungen der App frei konfigurierbar (Standard ist der
All-Hands-Runtime-Host). API-Keys werden nur an den Hub gesendet, nie auf dem Gerät
gespeichert.

### APK bauen

```bash
gradle :app:assembleDebug
```

oder automatisch über GitHub Actions (Workflow `.github/workflows/build-apk.yml`,
Artefakt `villaforge-apk`). Aktueller Stand liegt als `VillaForge.apk` im Repo.
