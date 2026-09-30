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
| Android-App (Kotlin/Compose) | `app/` | Gerüst: Datenmodell, Datenbank, SecureStore, Berechtigungen |

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
in Node 22+ enthaltenen Module `node:sqlite`, `fetch` und `EventEmitter`.

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
  Gesamtstand und legt fehlende Aufgaben nach (höchstens zwei Runden).
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
