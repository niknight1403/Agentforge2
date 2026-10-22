# VillaForge

## GitHub-Changelog-Agent 1.49.0

- GitHub-Push-Webhooks werden mit `X-Hub-Signature-256` anhand des unveränderten Bodys geprüft und pro Delivery-ID idempotent verarbeitet.
- Der Agent erstellt ohne kostenpflichtige Dienste einen strukturierten Changelog aus Commit-Nachrichten und postet ihn als Klartext via Telegram Bot API.
- Telegram-Ausfälle geben den Event-Claim frei, damit GitHub erneut zustellen kann; fehlende Zugangsdaten werden im Gateway-Status klar angezeigt.
- Einrichtung: `GITHUB_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` setzen; einen GitHub-Webhook mit Content-Type JSON, Ereignis `push` und derselben Signaturphrase auf `/api/v1/webhooks/github` konfigurieren.
- Versionen synchronisiert: Hub `1.49.0`, Android-Versioncode `46`.

## Villa-Steuerung 1.48.0

- Drei Villen können standardmäßig parallel laufen. Bei höherer Auslastung werden weitere Starts sichtbar und fair vorgemerkt.
- Jede wartende Villa lässt sich einzeln wieder aus der Warteschlange nehmen; ein laufender Stopp setzt nur diese Villa auf Pause.
- Der Start aktiviert die Autonomie wieder, auch wenn die Villa zuvor über den Master-Agenten pausiert wurde.
- Die Anzahl gleichzeitiger Villen ist auf mindestens drei eingestellt, damit gespeicherte alte Ein- oder Zwei-Slot-Werte den Parallelstart nicht still blockieren.

VillaForge ist ein privates System zum Erstellen von **Deep Agents**, die eine Idee in einer
**Villa mit bis zu 1000 Agenten** autonom planen, umsetzen und abschließen.

Beim Anlegen einer Villa öffnet sich automatisch das Chat-Fenster mit dem Deep Agent.
Ein Router wechselt standardmäßig zwischen **kostenlosen LLM-Anbindungen** und nutzt
bei Bedarf ein lokales Modell. Ohne erreichbares Sprachmodell bleibt die App bedienbar
und zeigt klar an, dass KI-Aufgaben derzeit nicht ausgeführt werden können.

## Neu in 1.47.0 — Mehr kostenlose Modelle und adaptive Kaskade

- **Neue Standardrouten**: Cerebras GPT-OSS/Qwen und Mistral Small erweitern
  den kostenfreien Fallback hinter Gemini; die Schlüssel bleiben ausschließlich
  in Umgebungsvariablen oder im Secrets-Store.
- **Kostenbremse bleibt aktiv**: Free-Only erlaubt nur bekannte kostenlose
  Modell-IDs. Unbekannte, bezahlte und kreditbasierte Routen werden übersprungen.
- **Lernende Routenwahl**: Erfolgsgewichtung wird innerhalb derselben Priorität
  pro Modellantwort berücksichtigt; Latenz, Fehler und Kontingent-Cooldowns
  aktualisieren die Wahl im laufenden Betrieb.
- **Sicherer Dauerbetrieb**: Bei ausgeschöpften Freikontingenten pausiert die
  Kaskade in den nächsten zulässigen Fallback; nach Neustarts greift die
  vorhandene Wiederaufnahme für unterbrochene Aufgaben.
- **Android- und Hub-Version synchronisiert**: `1.47.0`, Android-Versioncode
  `44`; der Tag-Build prüft Unit-Tests, Syntax und Versionsgleichheit.

Kostenlose Anbieter nutzen variable Kontingente und Limits. Einen unbegrenzten
kostenlosen 24/7-Modellbetrieb kann kein Anbieter garantieren; mit aktivierten
Schlüsseln verteilt VillaForge Anfragen über die zulässigen Routen und wechselt
bei Fehlern weiter.

## Neu in 1.46.0 — Produktstudio-Oberfläche

- Responsives Dashboard, Suche nach Villenname und Beschreibung sowie klarere
  Bedienelemente und einheitlichere Farben auf Web und Android.

## Neu in 1.45.0 — Kostenbewusste KI und Release-Stabilität

- **Kostenlose LLM-Kaskade als Standard**: Gemini Flash-Lite zuerst, danach
  Groq GPT-OSS, kostenlose OpenRouter-Modelle und lokale Inferenz. Der Hub
  überspringt bezahlte, kreditbasierte und unbekannte Routen standardmäßig.
- **Ehrlicher Modellstatus**: Dashboard und Bereitschafts-API zählen nur
  Routen, die nach der aktiven Kostenregel tatsächlich verwendet werden dürfen.
- **Professionellere Deep-Agent-Aufträge**: Anhänge werden begrenzt und
  gekennzeichnet in den Kontext übernommen; nicht analysierte Bilddateien
  werden nicht als geprüft ausgegeben. Bei echtem LLM-Ausfall bleibt der
  Status transparent statt erfundene Ergebnisse zu liefern.
- **Android- und Hub-Version synchronisiert**: `1.45.0`, Android-Versioncode
  `42`; ein Versionstag baut und veröffentlicht das getestete APK automatisch.
- **Qualitätssicherung**: 155 Hub-Tests sowie Android-Unit-Tests und
  Debug-Build im Release-Workflow.

Kostenlose Anbieter begrenzen Kontingente. Bei deren Erschöpfung nutzt der Hub
die nächste zulässige Route oder meldet die Nichtverfügbarkeit. Die Android-
Release-APK ist direkt installierbar und debug-signiert.

## Neu in 1.35.0 — Umsatz-Fokus & Endprodukt-Vision

- **Ziel sichtbar auf jeder Villa**: Die Agenten definieren WAS am Ende
  konkret verkauft wird (Endprodukt mit Preis) - als "Ziel:"-Zeile auf
  jeder Villen-Karte und im Detail.
- **Weg zum Umsatz**: Neue Vorschlagsart mit konkreten Schritten bis zum
  ersten Umsatz - Zielkunden, Preis in EUR, Verkaufspartner, Landingpage,
  Zahlungslink. Bestaetigen legt priorisierte UMSATZ-Aufgaben an.
- **Neue Idee (Umsatz-Pivot)**: Agenten pruefen nach dem Umsatz-Plan,
  ob ein weitaus umsatzstaerkeres Produkt auf der Kernidee moeglich ist -
  mit Umsatzschaetzung und MVP-Schritten.
- **CCC = Hauptumsatzprojekt**: Der Master priorisiert Umsatzschritte
  fuer das CyberSarah Control Center.

## Neu in 1.34.0 — Transparenz, Sprints & voller Master-Agent

- **Was macht die Villa + wie lange?**: Jede Villa zeigt ihre aktuelle
  Aufgabe und eine geschaetzte Restdauer (ETA aus der durchschnittlichen
  Aufgabe-Dauer): Liste, Detail und Fertigstellung.
- **Sprints & Perfektionierung**: Naechste-Phasen- und Perfektions-Vorschlaege
  sind echte Sprints mit Ziel-Wort, konkretem Artefakt im Akzeptanzkriterium
  und messbaren Perfektionszielen; jede Sprint-Karte zeigt ≈ Dauer.
- **Master-Agent steuert alles**: Villen per Namen stoppen, pausieren und
  starten - direkt aus dem Master-Chat.
- **ARBEITET/WARTET**: Live-Rechen-Slot-Status statt pauschal gruenem RUNNING.

## Neu in 1.33.1 — Live-Arbeitsstatus der Villen

- **ARBEITET vs. WARTET**: Der Hub liefert jetzt den echten Rechen-Slot-Zustand.
  Villen, die gerade arbeiten, pulsieren gruen (ARBEITET); Villen in der
  Warteschleife zeigen bernstein WARTET - statt pauschal alles gruen.
- Villen-Liste: Kopfzeile zaehlt "X arbeiten · Y warten".
- Uebersicht: Villen-Karte zeigt aktiv und wartend getrennt.

## Neu in 1.33.0 — MASTER-AGENT mit eigenem Chatfenster

- **Master-Agent-Chat**: eigener Tab „Master" — Wunsch reinschreiben (z.B.
  „aendere Bereich X" oder „baue mir Y"), der Master uebersetzt ihn in ein
  professionelles Entwicklungs-Prompt, gruendet autonom die passende Villa und
  startet die Entwicklung sofort. Erstellte Villa direkt aus dem Chat oeffenbar.
- **Kostenloses App-Designer-Tool-Pack**: zu jeder Gruendung entsteht
  automatisch ein Design-Konzeptbild (Pollinations.ai, kein API-Key) mit
  verankertem Cyber-Neon-Design-System.
- **Villa-Aufraeumen**: 5 versehentlich doppelt entstandene Duplikat-Villen
  entfernt; 13 eindeutige Villen, 5 laufen parallel getestet.

## Neu in 1.32.0

- **Ganzheitliches Cyber-Neon-Design**: Glas-Karten mit Neon-Gradient-Rändern
  jetzt auf ALLEN Screens (Villen, Details, Chat, Fertigstellung, Diagnose,
  Einstellungen) — einheitliches Control-Center-Gefühl statt Mix aus Stilen.
- **Hub-Qualitätssprung (OpenHands-Muster)**: Fail-Fast-Verifikation — nach
  jeder Code-Batch läuft sofort ein Build-/Testlauf statt erst am Rundenende;
  Fehler werden im selben Lauf als Prio-1-Aufgabe selbst geheilt. Der
  Phasen-Planer kennt jetzt die echten Baustellen (Lessons Learned).
- **LLM-Kette repariert (alle Villen)**: Gemini Flash Lite (verifiziert
  arbeitendes Gratis-Modell) auf Priorität 2, HuggingFace + OpenRouter-Keys
  im Hub-Secrets-Store, Cooldowns zurückgesetzt — keine „Kein Sprachmodell
  erreichbar"-Standardpläne mehr.

## Neu in 1.31.0 — Cyber-Neon-Redesign der Übersicht

- **Komplett neue Übersicht** im Control-Center-Design: Kopfzeile mit VillaForge-Logo
  und Benachrichtigungs-Glocke, Profil-Sektion mit Neon-Ring und Status-Badges,
  Kennzahlen-Chips (Agenten, Provider, Uptime), drei Einstiegskarten mit
  Fortschrittsringen (Systemstatus, KI-Chat, Villen), Aktivitäts-Karte mit
  Live-Badge und Marktreife-Sparkline sowie der Superagent-Banner mit direktem
  Zugang zur Villa-Evolution.
- **Neue Navigation**: Übersicht · Chat · Villen · Konto — die Übersicht ist jetzt
  Startbildschirm; Chat öffnet direkt die aktivste Villa.
- **Neue Design-Bausteine**: Glas-Karten mit Neon-Rand, Fortschrittsringe,
  Sparklines und Status-Chips (`ui/components/Neon.kt`), Neon-Palette in Theme.
- Mobile-optimiert: klare Hierarchie, größere Touch-Ziele, ein Blick pro Karte.

## Neu in 1.30.0

- **Villa-Evolution**: Jede Villa schlägt nach erledigten Aufgaben selbst vor,
  wie es weitergeht. Ist alles abgeschlossen, erzeugt sie einen Vorschlag für
  die **nächsten Phasen** (bestätigen → die Villa entwickelt eigenständig
  weiter, bis alle nötigen Phasen fertig sind). Danach schlägt sie Schritte zur
  **Perfektionierung und Optimierung** vor, bis das Projekt optimal fertig
  ist. Zusätzlich bekommt jede Villa einen eigenen **AI-Marketplace-Vorschlag**
  für ihr Projekt. Nichts startet ohne Bestätigung des Besitzers.
- **Ehrliche Fertigstellung**: „Alle Phasen 100 %“ zählt nur, wenn der
  Projektordner echte Dateien enthält. Bei leerem Workspace verlangt der
  Vorschlag zwingend echte Code-Aufgaben — der Build-Fehler „Workspace ist
  leer“ wird damit an der Wurzel behoben.
- App: Neuer Bereich „Villa-Evolution“ in der Fertigstellungs-Ansicht mit
  Vorschlags-Karten, Bestätigen/Ablehnen und drei Anstoß-Buttons.
- Hub-Routen: `/api/evolution/villas/:id`, `.../propose`,
  `/api/evolution/proposals/:id/approve|reject`, `/api/evolution/pending`,
  `/api/evolution/tick`; automatischer Takt alle 30 Minuten.

## Neu in 1.12.0

- **Feature- und Werkzeug-Packs** sind jetzt serverseitig die eine Wahrheit
  (`server/packs.mjs`, `GET /api/packs`, `PATCH /api/packs/:id`). Ein Pack ist
  ein echter Schalter, keine Deko: ist sein Werkzeug-Pack aus, blockiert der Hub
  das Werkzeug im Lauf und protokolliert den Versuch als „blockiert“ im Audit.
  Der Hauptschalter „Werkzeuge“ sperrt alle Werkzeug-Packs auf einmal. Web-UI
  und Android-App zeigen und schalten dieselbe Liste.
- **Werkzeuge sichtbar**: `GET /api/tools` liefert zu jedem Werkzeug sein Pack
  und die aktuelle Freigabe — frisch berechnet, kein eingefrorener Stand. Die
  Web-UI hat dafür den Bereich „Werkzeuge & Packs“.
- **Live-Test im echten Browser**: `npm run test:live` startet einen isolierten
  Hub und fährt ihn in Chrome bis zum Ende durch — Villa anlegen, alle Reiter,
  Chat, Entwicklung starten/stoppen, Aufgabenfilter — und protokolliert
  Konsolenfehler, 5xx-Antworten und abgebrochene Anfragen.
- **Design-Audit statt Geschmacksfrage**: `npm run test:design` misst die
  gerenderte Oberfläche gegen harte Kriterien (WCAG-Kontrast, Überlauf,
  Touch-Ziele ab 44 px, Schriftgröße ab 11 px, benannte Bedienelemente,
  doppelte IDs, `:focus-visible`, `prefers-reduced-motion`). Beide Läufe hängen
  in CI (`live-e2e.yml`) und legen Berichte plus Screenshots als Artefakt ab.
- **Design-Runde**: der Ring der Hero-Kugel saß am falschen Bezugselement, das
  helle Ende des Primär-Verlaufs erreichte nur 4.05:1 Kontrast (jetzt 5.1:1),
  es gab keine Fokus-Ringe und keine Rücksicht auf reduzierte Bewegung, 30
  Stellen lagen unter 11 px und 10 Touch-Ziele unter 44 px — alles behoben.
  Dazu Toasts und ein `<dialog>`-Modal statt `alert`/`confirm`/`prompt`.

## Neu in 1.10.0

- Key-Pool mit Kontingent-Rotation: `GROQ_API_KEY`, `OPENROUTER_API_KEY`,
  `GEMINI_API_KEY`, `CEREBRAS_API_KEY` akzeptieren nummerierte Zweit-Keys
  (`_2` bis `_12`, Secrets-Store oder Umgebung). Bei 429/402 rotiert der
  Anruf sofort auf den nächsten Key derselben Route, bevor die Route
  pausiert — Gratis-Kontingente mehrerer Keys bündeln sich.
- `GET /api/stats` meldet `keyPools[]` (Namen + `ready`-Zahl, nie Werte)

## Neu in 1.9.0

- Auto-Resume: Scheitert ein Lauf nur an erschöpften Gratis-Kontingenten,
  nimmt der Hub ihn eine Stunde später von selbst wieder auf — ohne Klick
  und ohne externen Weckruf (Audit-Eintrag `auto_resume`, Web-UI-Kachel
  „Auto-Fortsetzung ~HH:MM“)
- `tasks.quota_blocked` trennt Kontingent-Fehler von echten Fehlschlägen;
  nur reine 429-Restarts laufen automatisch, 401/403 bleiben rot
- `villas.auto_retry_at` im Villa-Objekt der API

## Neu in 1.8.0

- Adaptives Batching: die Lauf-Parallelität sinkt auf die Zahl wirklich
  einsatzbereiter LLM-Routen — eine Route übrig heißt eine Aufgabe gleichzeitig
- Versuchszähler pro Aufgabe: `tasks.attempts` zählt jeden Anlauf (inkl.
  Selbstheilung und Retry), die Web-UI zeigt „FAILED · Versuch N"
- Web-UI: „Neu starten" an jeder fehlgeschlagenen Aufgabe plus Sammel-Button
  „Fehlgeschlagene Aufgaben erneut starten" über dem Aufgabenplan
- Retry-Endpunkte schreiben Audit-Einträge (`retry_task`/`retry_failed`)
- Android: Routen-Gesundheit (ok/fail, konfigurierte Routen, Cooldown-Liste)
  in der Hub-Statistik
- LLM-Smoke-Test in CI: erschöpfte Gratis-Kontingente (429) gelten als bestanden,
  wenn die Keys gültig sind; echte Key-/Konfigurationsfehler bleiben rot

## Neu in 1.7.0

- Selbstheilung bei Groq-Tool-Fehlern: `Tool-400` (gpt-oss) wird einmal sofort wiederholt
- Retry-Endpunkte: `POST /api/villas/:id/tasks/:taskId/retry` (Einzelaufgabe) und
  `POST /api/villas/:id/retry-failed` (alle gescheiterten Aufgaben auf einmal)
- `GET /api/stats` meldet `routesHealth` (ok/fail/cooling/configured)
- Android: „Aufgabe erneut starten" an fehlgeschlagenen Aufgaben und
  „Fehlgeschlagene Aufgaben erneut starten" in der Villa-Ansicht

## Neu in 1.6.0

- `GET /api/villas/:id/audit` — Werkzeug-Protokoll mit Pagination (`limit`/`offset`)
- Rate-Limit-Header `X-RateLimit-Limit/-Remaining/-Reset` auf schreibenden Anfragen
- Statische Dateien mit ETag: `If-None-Match` liefert 304
- Wartungslaufen schließen WAL-Checkpoint und `PRAGMA optimize` an
- Web-UI: Hub-Backup als Datei, Wartungsaufruf mit Trockenlauf, Statistik-Leiste
- Android: Aufgabenplan mit Statusfilter, Hub-Statistik in den Einstellungen
- Vollständige API-Referenz unter `docs/API.md`

## Bestandteile

| Teil | Pfad | Status |
| --- | --- | --- |
| VillaForge Hub (Server + Web-UI) | `server/` | fertig, lauffähig, getestet |
| Android-App (Kotlin/Compose) | `app/` | fertig: Villa-Ansicht, Deep-Agent-Chat, SSE-Live-Ereignisse |

## Hub starten

```bash
node server/server.mjs          # Standard-Port 12000
PORT=12001 node server/server.mjs
node server/server.mjs --check  # Konfiguration trocken prüfen, ohne Port zu belegen
```

Ungültige Konfiguration (z. B. `PORT=abc`) bricht mit klarer Meldung und Exit 1 ab.

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

### Optionaler API-Schutz (VF_TOKEN)

Wird beim Start `VF_TOKEN=geheim` gesetzt, verlangt der Hub für alle `/api/*`-Endpunkte
inklusive SSE den Header `Authorization: Bearer <Token>`. Nur `GET /api/health` bleibt
offen (Ueberwachung). Ohne `VF_TOKEN` aendert sich nichts — die Weboberflaeche funktioniert
dann ohne Token. Hinweis: die Android-App setzt aktuell keinen Bearer-Header; der Schutz
richtet sich an Remote-Deployments mit eigenem Client.

**Clients:** Web-UI und Android-App haben je ein Token-Feld (nur lokal gespeichert).
Da EventSource keine Header senden kann, akzeptiert der Hub zusaetzlich `?token=` —
`/api/health` bleibt ohne Token offen.

## Grenzen & Hygiene

- **Rate-Limit:** Schreibende Anfragen sind pro IP auf 120/Minute begrenzt
  (`VF_RATE_LIMIT=0` schaltet ab). GET und SSE bleiben frei. Ueberschuessige
  Anfragen erhalten `429` mit `Retry-After`.
- **Paginierung:** `GET /api/villas` liefert standardmaessig 50 Eintraege
  (max. 200 via `?limit=`), Blaettern via `?offset=`; Gesamtzahl im
  `X-Total-Count`-Header. Villa-Detail (Agenten/Aufgaben) und Chat-Verlauf
  sind auf 500 Eintraege gedeckelt.
- **History-Rotation:** Nach jedem Lauf kuerzt der Hub pro Villa `audit` auf
  die letzten 400 und `memories` auf 300 Eintraege; Erinnerungen mit
  `importance >= 8` ueberleben immer.
- **Orchestrierung:** `concurrency` 1–16, `maxTasks` 1–5000, `maxRounds` 1–20 —
  unsinnige Werte werden mit `400` abgelehnt statt stillschweigend geklemmt.
- **Pfad-Sicherheit:** `safePath` weist Symlinks ab, die aus dem Projektordner
  herausfuehren (inklusive haengender Links und Link-Schleifen);
  gelesen werden nur Textdateien.

## Entwicklung & Tests

```bash
npm test               # 181 Unit- und Integrationstests (node:test, ohne Abhaengigkeiten)
npm run test:live      # Live-Test im echten Chrome (braucht Chrome oder Chromium)
npm run test:design    # Design-Audit der gerenderten Oberflaeche
npm run check:secrets  # scannt den Quelltext auf committete API-Keys
```

Die Suite besteht aus sechs Schichten:

| Schicht | Datei | deckt ab |
| --- | --- | --- |
| Datenbank & Tools | `db.test.mjs`, `agents.test.mjs`, `fs-tools.test.mjs` | Schema, Seed, Werkzeuge, Audit |
| LLM-Rotator | `llm.test.mjs` | Key-Aufloesung, Prioritaet/Rotation, Failover, Offline-Planer |
| Validierung | `validate.test.mjs` | Eingabegrenzen aller POST-Endpunkte |
| Packs | `packs.test.mjs`, `packs-api.test.mjs` | Pack-Registry, Werkzeugsperre, Schalter-Endpunkte |
| Oberflaeche (statisch) | `ui-contract.test.mjs`, `ui-design.test.mjs` | IDs und Handler, Design-Regeln direkt im Quelltext |
| Integration | `api-e2e.test.mjs`, `api-auth.test.mjs` | echter Hub-Prozess ueber HTTP: Anlegen, Chat, SSE, Orchestrierung, VF_TOKEN |

Darueber liegen zwei Browser-Laeufe (`live-e2e.yml`): der Live-E2E klickt die
Oberflaeche in Chrome durch, das Design-Audit misst Kontrast, Ueberlauf,
Touch-Ziele, Fokus und reduzierte Bewegung. Beide schreiben einen Report und
Screenshots nach `artifacts/` — in CI als Build-Artefakt, nicht ins Repo.

CI (`hub-tests.yml`) prueft Syntax, Secret-Scan und die komplette Suite bei jedem Push
unter `server/**`; `build-apk.yml` baut die Android-APK. Alles ohne Fremd-Abhaengigkeiten
und ohne echte Keys — Tests laufen vollstaendig im Offline-Planer.

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
- **Löschen, Export und Import**: `DELETE /api/villas/:id` entfernt eine Villa mitsamt aller Daten
  (409, solange der Lauf aktiv ist); `GET /api/villas/:id/export` liefert alles als
  JSON-Datei. `POST /api/villas/import` stellt so eine Datei als neue Villa wieder her
  (neue IDs, übernommene Agenten/Aufgaben/Gedächtnis/Berichte/Nachrichten). In Web-UI und
  Android-App per Knopf erreichbar.
- **Bearbeiten**: `PATCH /api/villas/:id` ändert `name`, `idea` oder `mode` als Teil-Update;
  Web-UI und Android-App bieten einen Bearbeiten-Dialog.
- **Aufgaben verwalten**: `GET /api/villas/:id/tasks` mit `?status=`-Filter; `PATCH
  /api/villas/:id/tasks/:taskId` setzt Status, Priorität oder Ergebnis (409, solange die
  Aufgabe läuft). Der Aufgabenplan der Web-UI filtert nach Status.
- **Backup und Wartung**: `GET /api/backup` liefert den kompletten Hub als JSON-Dump (jede
  Villa direkt wieder importierbar); `POST /api/maintenance/prune` räumt Audit-Protokoll und
  Nachrichten älter als `days` Tage weg — mit `dryRun` erst zählen.
- **Dauerhaftes Protokoll**: `VF_LOG_FILE` schreibt jede Logzeile zusätzlich synchron in
  eine Datei (Ordner wird angelegt; Schreibfehler beenden den Hub nie).
- **Statistik**: `GET /api/stats` zählt Villen, Agenten, Aufgaben, Berichte, Erinnerungen
  und offene Läufe — App und Web-UI zeigen die Zahlen.
- **SSE mit Replay**: Jedes Ereignis trägt eine `id`; verbindet sich ein Client mit
  `Last-Event-ID` neu, liefert der Hub die letzten 200 verpassten Ereignisse nach.
- **Sauberes Herunterfahren**: Bei SIGTERM/SIGINT werden laufende Villen gestoppt, der
  Server geschlossen und Exit 0 geliefert.
- **LLM-Routen-Rotator**: Priorität plus Rotation, Failover bei Fehler, Statistik je Route.
  Eine fehlgeschlagene Route wird für 60 Sekunden gesperrt (nach weiteren Fehlern länger,
  höchstens 10 Minuten). Das verhindert, dass jeder Aufruf erneut in dieselbe tote Route läuft.
- **Secrets**: API-Keys liegen nur serverseitig in der Datenbank und werden nie angezeigt.

## Kostenlose LLM-Routen (Katalog)

Die automatische Kaskade ist standardmäßig auf kostenlose Routen begrenzt
(`VF_LLM_FREE_ONLY=1`). Sie versucht Gemini Flash-Lite, danach Groq GPT-OSS
und kostenlose OpenRouter-Modelle und zuletzt lokal gehostete Modelle. Unbekannte,
bezahlte und kreditbasierte Routen werden übersprungen. Zum bewussten Zulassen
weiterer aktivierter Routen kann `VF_LLM_FREE_ONLY=0` gesetzt werden.

| Prioritaet | Route | Modell | Key |
| --- | --- | --- | --- |
| 1 | Google Gemini 3.5 Flash-Lite | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` |
| 2 | Groq GPT-OSS 120B / 20B | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | `GROQ_API_KEY` |
| 3 | OpenRouter kostenlose Modelle | Modell-ID mit `:free` | `OPENROUTER_API_KEY` |
| 4 | Ollama oder LM Studio lokal | lokal installiertes Modell | keiner |

Kostenlose Kontingente haben Anbieterlimits und sind nicht unbegrenzt verfügbar.
Bei erschöpftem Kontingent wechselt der Hub zur nächsten kostenlosen Route oder
meldet, dass kein Modell erreichbar ist. Gemini-Flash-Lite-Anfragen im kostenlosen
Tarif können vom Anbieter zur Produktverbesserung verwendet werden; sende darüber
keine vertraulichen Quelltexte oder Kundendaten. Die Gemini-Standardroute wird
bei vorhandenen Installationen automatisch von `auto` und Gemini 2.0 Flash auf
Flash-Lite aktualisiert; ausdrücklich konfigurierte andere Modelle bleiben bestehen.

Für Cloud-Nutzung einen Anbieter-Key als Umgebungsvariable oder über
„API-Key hinterlegen“ speichern. Ein Gemini-Key lässt sich kostenlos in
[Google AI Studio](https://aistudio.google.com/apikey) erstellen. Alternativ
Ollama oder LM Studio auf dem Host des Hubs einrichten. Mindestens eine
erreichbare Route samt Key (Cloud) oder lokalem Modell ist nötig; Kontingente
begrenzen die Zahl und Geschwindigkeit kostenloser Anfragen.

### Gratis-Betrieb und Kontingent-Selbstheilung

Gratis-Stufen haben enge Token-Fenster (z. B. Groq: 8.000 Token pro Minute und
Modell). Ein Agentenaufruf verbraucht grob 3.000-4.000 Token, also passen nur
wenige Anrufe pro Minute ins Fenster. Der Hub behandelt das als NORMAL und nicht
als Fehler:

- **429 (Rate Limit)** sperrt die betroffene Route nur kurz (45 s) und eskaliert
  nicht – das Fenster entleert sich, dann geht es weiter.
- **Transienter Offline-Fall** (Keys vorhanden, aber alle Kontingente gerade
  voll): Der Agentenlauf wartet und wiederholt den Schritt (zweimal), die
  Orchestrierung schiebt offline gescheiterte Aufgaben zurück in die
  Warteschlange (zwei Extraversuche) und pausiert kurz zwischen den Runden.
  Erst danach bleibt die Aufgabe ehrlich `FAILED` und die Villa `PAUSED` statt
  falschen Erfolg zu melden.
- **Bewusster Offline-Betrieb** (gar kein Key konfiguriert): Aufgaben laufen
  direkt über den lokalen Planer und werden `DONE` – der Hub probiert keine
  toten 401er-Kaskaden ab. Auch das ist ein gültiger Modus.
- `VF_RATE_WAIT_MS` (Standard 45000) steuert die Wartezeit zwischen den
  Wiederholungen – für Tests niedrig setzbar.

Route-Fehler landen im Hub-Log („Route fehlgeschlagen"), ein kippender Lauf ist
damit von außen diagnostizierbar.

## API-Kurzreferenz

Vollständige Endpunkt-Referenz mit Beispielen: [docs/API.md](docs/API.md).


```
GET    /api/health
GET    /api/stats                       Zaehler und Laufzustand
GET    /api/villas                      ?limit=, ?offset= (Paginierung)
DELETE /api/villas/:id                  Villa mitsamt Daten loeschen (409 bei laufendem Lauf)
PATCH  /api/villas/:id                { name?, idea?, mode? } – Teil-Update
GET    /api/villas/:id/export           kompletter JSON-Download
POST   /api/villas/import             Export-JSON als neue Villa anlegen
POST   /api/villas                    { name, idea, agentCount, sourcePath? }
GET    /api/villas/:id/tasks          ?status=PENDING|RUNNING|DONE|FAILED|BLOCKED, ?limit=
PATCH  /api/villas/:id/tasks/:taskId  { status?, priority?, result? } – 409, wenn die Aufgabe laeuft
GET    /api/backup                    kompletter Hub-Dump (villas-Array ist importierbar)
POST   /api/maintenance/prune         { days, dryRun? } – alte Protokolle aufraeumen
GET    /api/villas/:id                Villa, Agenten, Aufgaben, Gedächtnis, Berichte, Audit
GET    /api/villas/:id/audit           ?limit=, ?offset= – Werkzeug-Protokoll mit Pagination
POST   /api/villas/:id/source         { path } – Quellprojekt hinterlegen
POST   /api/villas/:id/analyze        Projekt analysieren, Bericht + REBUILD/OPTIMIZE
GET    /api/villas/:id/reports        Analyse- und Verifikationsberichte
POST   /api/villas/:id/orchestrate    { concurrency, maxTasks, adaptive } – Entwicklung starten; manuelle Starts laufen durch den Villa-Scheduler
POST   /api/villas/:id/stop           Entwicklung stoppen
GET    /api/villas/:id/messages?agentId=
POST   /api/villas/:id/chat           { message, agentId }
GET    /api/villas/:id/suggestions    datenbasierte nächste Schritte für die Villa
GET    /api/villas/duplicates         Duplikat-Gruppen als sichere Vorschau
POST   /api/villas/duplicates         { apply: true, ids: [...] } – nur bestätigte Kandidaten löschen
POST   /api/agents/:id/chat           { message }
GET    /api/master/status             Villen, Packs, Werkzeuge, Skills, Connectoren und Dubletten
GET    /api/master/messages           dauerhafter globaler Verlauf
POST   /api/master/chat               { message, requestId } – wiederholsichere Konfiguration
GET    /api/master/turn/:requestId     Ergebnis einer laufenden Anfrage
GET    /api/master/suggestions        priorisierte, kontextbezogene Vorschläge
GET    /api/master/duplicates         Vorschau genauer Duplikate
POST   /api/master/duplicates/archive reversible Bereinigung; Aufgaben und Verläufe bleiben erhalten
```

Manuelle Starts erlauben standardmäßig mindestens drei gleichzeitig laufende
Villen (Vorgabe: 3). Weitere Villen bleiben sichtbar in der Warteschlange und
rücken automatisch nach, sobald ein Slot frei wird. Wartende Starts können
einzeln abgebrochen werden; ein Stopp pausiert nur die ausgewählte Villa. Die Web-Oberfläche zeigt
Empfehlungen aus Aufgabenstatus, Fehlern, Fortschritt, Agentenauslastung,
Quellprojekt, Berichten und dem letzten Chat-Kontext.

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

neu gebaut. Die Hub-Adresse ist in der App unter Einstellungen änderbar; der Standardwert ist
`http://10.0.2.2:12000` (Emulator-Loopback zum Host-Rechner). Auf einem echten Gerät die
LAN-Adresse des Hub-Rechners eintragen (z. B. `http://192.168.1.20:12000`). Die gesamte Agenten-, LLM- und Werkzeuglogik läuft im
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
- Optionaler Bearer-Schutz über `VF_TOKEN` (siehe oben).
- `scripts/check-secrets.mjs` verhindert in CI, dass versehentlich ein echter Key
  committet wird (Muster fuer Groq, OpenRouter, OpenAI, Anthropic, Gemini, GitHub,
  Slack, AWS, PEM-Blocks).
- Die Testsuite ist hermetisch: eigene temporäre Datenbank je Prozess, LLM-Key-
  Umgebungsvariablen werden im Testprozess entfernt.

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


Der globale Master-Agent verwendet die vorhandenen KI-Routen für freie Konfigurationswünsche.
Status, Dublettenbereinigung und `Erstelle Villa "Name": Ziel` funktionieren auch offline.
Villen werden mit Projektauftrag angelegt und erst auf ausdrücklichen Startwunsch ausgeführt.
Eigene Skills wirken in den Agenten-Anweisungen; Werkzeug- und Pack-Schalter werden bei jedem Aufruf geprüft.
Connectoren unterstützen öffentliche HTTPS-JSON-GET-Endpunkte mit optionaler vorhandener Secret-Referenz.
OAuth- und MCP-Installationen benötigen ihre eigene Einrichtung. Schlüsselwerte gehören nicht in den Chat.
Die appweite Verwaltung ist im Benutzer-Hub Administratoren vorbehalten.
