# VillaForge Hub — API-Referenz

Alle Endpunkte liefern JSON (`application/json; charset=utf-8`) und sind
relativ zur Hub-Adresse, Standardport `12000`. Die Android-App und die
Web-UI nutzen exakt diese Schnittstelle.

> Kurzreferenz zum Scannen bleibt im README; hier stehen Formen,
> Beispiele und Fehlercodes im Detail.

## Gratis-Kontingente und Selbstheilung

Gratis-LLM-Stufen arbeiten mit engen Token-Fenstern (Groq z. B. 8.000 TPM je
Modell). Der Hub interpretiert erschöpfte Kontingente als Warte-Situation, nicht
als Endfehler:

| Situation | Verhalten |
| --- | --- |
| 429 von einem Anbieter | Route pausiert 45 s, danach neuer Versuch; keine Eskalation |
| Alle Kontingente voll | Agentenschritt wartet `VF_RATE_WAIT_MS` (45 s) und wiederholt sich (max. 2x); Orchestrierung reiht offline gescheiterte Aufgaben wieder ein (max. 2x) und wartet zwischen Runden |
| Trotzdem erfolglos | Aufgabe bleibt `FAILED`, Villa endet `PAUSED` (nie falsches `COMPLETED`) |
| Kein Key konfiguriert | Bewusster Offline-Betrieb: Planer-Antworten, Aufgaben werden `DONE`, kein 401er-Proben |

Scheitert eine Route, steht eine Zeile im Hub-Log:
`[villaforge] Route fehlgeschlagen (<Name>): <Fehler>`.

## Konventionen

- **Auth:** Ist `VF_TOKEN` gesetzt, verlangt jeder Endpunkt außer
  `GET /api/health` den Header `Authorization: Bearer <token>`.
  Ohne oder mit falschem Token: `401 {"error":"Token ungültig oder fehlt"}`.
- **Rate-Limit:** Schreibende Anfragen (nicht GET, nicht SSE) sind pro IP
  auf `VF_RATE_LIMIT` pro Minute begrenzt (Standard 120, `0` schaltet ab).
  Antworten tragen `X-RateLimit-Limit`, `X-RateLimit-Remaining` und
  `X-RateLimit-Reset` (Sekunden bis zum Ablauf des Fensters); bei
  Überschreitung folgt `429` mit `Retry-After`.
- **Fehler:** immer `{"error": "<meldung>"}` mit passendem Statuscode
  (`400` Validierung, `401` Token, `404` unbekannt, `409` Konflikt,
  `429` Rate-Limit, `500` Server).
- **Statische Dateien** (Web-UI) tragen `ETag`; `If-None-Match` liefert `304`.

## Gesundheit, Metriken, Wartung

### `GET /api/health`
Lebendigkeit ohne Token-Schutz.

```json
{ "ok": true, "ts": 1759600000000, "routes": 3, "version": "1.7.0" }
```

### `GET /api/stats`
Zähler und Laufzustand: `uptimeSec`, Tabellenzeilen (`villas`, `agents`,
`tasks`, `audit`, …), `runningVillas`, `version` und `routesHealth`:
`{ ok, fail, cooling[], configured }` — Summe der LLM-Anrufe, die gerade
drosselnden Routen (`cooldown[]`) und wie viele echte Routen einen
funktionsfähigen Key haben.

### `GET /api/backup`
Kompletter Hub-Dump als Download
(`Content-Disposition: attachment`). Jedes Element aus `villas[]` ist
direkt per `POST /api/villas/import` wieder anlegbar.

### `POST /api/maintenance/prune`
```json
{ "days": 90, "dryRun": true }
```
Löscht `audit`-Einträge und Chat-Nachrichten älter als `days` Tage
(1–3650). `dryRun: true` zählt nur (`deleted.audit`,
`deleted.messages`, `deleted.total`). Ein echter Lauf vermerkt
`optimized: true` (WAL-Checkpoint + `PRAGMA optimize`).

## Villen

### `GET /api/villas?limit=&offset=`
Paginierte Liste mit `villas[]`, `total`, `limit`, `offset`.

### `POST /api/villas`
```json
{ "name": "Meine Villa", "idea": "Ein Budget-Tool bauen", "agentCount": 12, "sourcePath": "/pfad/zum/projekt" }
```
`agentCount` 3–1000 (Standard 12). Antwort `201`:
```json
{ "ok": true, "villaId": 7, "agents": 12, "plannedTasks": 34 }
```

### `GET /api/villas/:id`
Detailobjekt: `villa`, `agents[]` (Wurzel zuerst), `tasks[]`,
`memories[]`, `reports[]` (letzte 50), `audit[]` (letzte 200),
`running` (bool).

### `PATCH /api/villas/:id`
```json
{ "name": "Neuer Name", "idea": "Andere Idee", "mode": "CODING" }
```
Alle Felder optional; mindestens eines nötig, sonst `400`.

### `DELETE /api/villas/:id`
Löscht die Villa mitsamt Agenten, Aufgaben, Gedächtnis, Berichten und
Nachrichten. `409`, solange ein Lauf aktiv ist.

### `GET /api/villas/:id/export`
Villa als importierbares JSON (gleiche Form wie ein Element aus
`/api/backup`).

### `POST /api/villas/import`
Body: ein Export-JSON. Legt die Villa mit neuen IDs an, Antwort `201`
mit `villaId` und übernommenen Zählern.

## Aufgaben, Audit, Analyse

### `GET /api/villas/:id/tasks?status=&limit=`
`status` aus `PENDING|RUNNING|DONE|FAILED|BLOCKED`, `limit` max 500.

### `PATCH /api/villas/:id/tasks/:taskId`
```json
{ "status": "DONE", "priority": 2, "result": "fertig" }
```
Eine laufende Aufgabe (`RUNNING`) kann nicht weg-gesetzt werden: `409`.

### `GET /api/villas/:id/audit?limit=&offset=`
Werkzeug-Protokoll mit Pagination. Antwort:
```json
{ "villaId": 7, "total": 214, "limit": 100, "offset": 0,
  "entries": [ { "id": 214, "tool": "writeFile", "args": "{}", "result": "…", "allowed": 1, "ts": 1759600000000 } ] }
```
`limit` max 500 (Deckelung), `offset` nie negativ, Offset hinter dem
Ende liefert eine leere Seite.

### `POST /api/villas/:id/source` · `POST /api/villas/:id/analyze`
Quellpfad hinterlegen bzw. Projekt analysieren (Bericht + Empfehlung
`REBUILD`/`OPTIMIZE`). Berichte: `GET /api/villas/:id/reports`.

## Entwicklung und Chat

### `POST /api/villas/:id/orchestrate`
```json
{ "concurrency": 4, "maxTasks": 200, "adaptive": true }
```
Startet die Entwicklung, Antwort enthält `started: true`.

### `POST /api/villas/:id/stop`
Stoppt einen laufenden Lauf (`409`, falls keiner läuft).

### `POST /api/villas/:id/tasks/:taskId/retry`
Stellt eine `FAILED`-Aufgabe zurück auf `PENDING` und setzt den
Selbstheilungs-Lauf fort. `409` auf Nicht-FAILED-Aufgaben, `404` auf
unbekannte Aufgaben. Antwort: `{ requeued, started | alreadyRunning }`.

### `POST /api/villas/:id/retry-failed`
Requeued alle `FAILED`-Aufgaben der Villa auf einmal und startet den
Lauf; `requeued: 0`, falls keine vorhanden sind.

### `GET /api/villas/:id/messages?agentId=`
Chatverlauf, optional auf einen Agenten gefiltert.

### `POST /api/villas/:id/chat` · `POST /api/agents/:id/chat`
```json
{ "message": "Woran arbeitest du?", "agentId": 3 }
```
Antwort enthält `answer` und die verwendete Route (`model`, `route`,
`offline`).

## Routen, Secrets, Werkzeuge, Events

- `GET/POST /api/routes`, `PATCH /api/routes/:id` — LLM-Routenpflege
  (`{ enabled, priority }`). Secrets nie im Klartext.
- `GET /api/secrets` liefert nur Namen; `POST /api/secrets`
  speichert `{ name, value }` serverseitig; `DELETE /api/secrets/:name`.
- `GET /api/tools` — Whitelist der Agenten-Werkzeuge inklusive Spezifikation.
- `GET /api/events` — Server-Sent Events (`text/event-stream`): alle
  Lifecycle-Ereignisse (`type`, `villaId`, `ts`, …) mit aufsteigender
  `id`. Bei Reconnect sendet `EventSource` automatisch `Last-Event-ID`;
  der Hub replays alles seit dieser ID (Retention begrenzt). Ein
  Kommentar-Ping alle 15 Sekunden hält Proxys offen.
