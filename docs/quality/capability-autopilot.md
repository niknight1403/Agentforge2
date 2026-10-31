# Faehigkeiten-Autopilot

## Einbindung

Der bestehende Entwicklungszyklus (`developCycle`) bekommt einen begrenzten Integrationsschritt. Es gibt keinen zweiten Scheduler, keine weitere Datenbank, keine zusaetzliche Providerkaskade und keine eigenstaendige Endlosschleife. Die eigene SQLite-Tabelle `capability_requests` haelt deduplizierte Anforderungen und Nachweise je Villa.

Der Autopilot ist standardmaessig fuer aktive autonome Villen freigegeben. Er setzt weder Autonomie noch Startstatus. Pausierte, gestoppte, archivierte oder abgeschlossene Villen werden nicht gestartet. Der globale Schalter `capabilityAutopilot` (0/1) ist ueber die vorhandene Master-Einstellungsverwaltung erreichbar. Deaktivierung verhindert neue Integrationsauftraege; bereits angenommene Aufgaben bleiben im vorhandenen Backlog und werden mit der Villa gestoppt.

## Belegte Ausloeser

- Wiederholt aufgerufenes, unbekanntes Werkzeug: erste Beobachtung wird gespeichert, zweite Beobachtung kann einen projektlokalen Adapterauftrag erzeugen.
- Echter Projektlauf mit Missing-Module/ENOENT: ein deduplizierter Abhaengigkeitsauftrag, ohne rohe Fehlerausgabe im Faehigkeitskatalog.
- Konkreter Medienauftrag ohne Provider: sichtbarer Zustand `needs_configuration`, kein behaupteter Render-Erfolg und keine kostenpflichtige Ersatzroute.
- Der Root-/Projektagent meldet anhand der Originalidee fehlende Features oder Tools mit Ziel und ausfuehrbarer Abnahme ueber `capability_request`.

Der Autopilot kann keine unbekannten Anforderungen aus dem Nichts beweisen. Die Originalidee, echte Werkzeugfehler und ausdrueckliche Anforderungen bleiben die Quelle.

## Ausfuehrung und Grenzen

Je bestehendem Zyklus entstehen maximal zwei Aufgaben. Je Villa werden hoechstens 50 unterschiedliche Anforderungen gehalten. Umsetzung und Review sind getrennte Aufgaben im vorhandenen Scheduler. Maximal drei erkannte fehlgeschlagene Bearbeitungen; danach wird keine weitere automatische Bearbeitung zugelassen. Administrativ gesperrte Packs werden nicht aktiviert oder umgangen.

Externe Integrationen bleiben `needs_configuration`, bis die benoetigte autorisierte Ressource eingerichtet ist. Danach kann dieselbe ID als pruefbarer `tool`-/`feature`-Auftrag erneut eingereicht werden. Dies ist keine Erfolgsfreigabe: die normale Umsetzungs- und Reviewkette bleibt Pflicht.

Neue Werkzeuge sind projektlokale, pruefbare Adapter. Kein `eval`, keine dynamische Hub-Registrierung und keine automatischen Host-/Kontorechte. Externe Kosten, Keys, Quoten und Dienstberechtigungen werden nicht erzeugt oder umgangen.

## Abnahme

`DONE`-Text allein validiert keine Faehigkeit. `capability_verify` verlangt:

1. Abgeschlossene Implementierungsaufgabe mit zugeordnetem Agenten.
2. Anderen zugeordneten Reviewer/Tester/Verifier/Integrator und einen tatsaechlichen Review-Auftrag.
3. Frischen, zum Quell-Fingerprint passenden Build-, Test- und Smoke-Nachweis.
4. Existierenden, nichtleeren Akzeptanztest und eine separate Implementierungsdatei innerhalb des freigegebenen Projekts; keine Traversal-/Symlink-Ausbrueche.

Nach einer Quellaenderung wird ein alter Nachweis als `evidence_stale` angezeigt. Offene Pflichtfaehigkeiten blockieren sowohl die Produktabnahme als auch das Ultra-Release-Gate. Die Validierung einer projektlokalen Faehigkeit ersetzt nicht die gesamte Produktabnahme.

## Bedienung

Im Villa-Arbeitsbereich unter **Aufgaben → Faehigkeiten-Autopilot** stehen Status, Ziel, Abnahme und die zugehoerige Aufgabe. Die Rubrik ist einklappbar; das gewaehlte Aurora-Design und die primaeren Start-/Stop-Knoepfe bleiben erhalten.

- `GET /api/villas/:id/capabilities`: Status fuer Administratoren.
- `POST /api/villas/:id/capabilities`: schema-validierter Auftrag; kein impliziter Start.
- Agentenwerkzeuge: `capability_status`, `capability_request`, `capability_verify`.

Ein Auftrag hat `id` (stabile ASCII-ID), `kind` (`feature`, `tool`, `integration`), `title`, `goal`, `acceptance`. Ein bestehender Auftrag wird nicht bei jedem Zyklus neu erzeugt. Secrets gehoeren nicht in Ziele oder Abnahmetexte.

## Nachweise und Betrieb

Die Tests fuehren unter anderem einen echten kleinen Node-Projekt-Build, Akzeptanztests und einen Smoke-Lauf in einem isolierten Workspace aus. Sie pruefen Rollenabstand, Pfadgrenzen, stale Nachweise, Pause, Pack-Sperren, Task-Budget, Fehlerbudget und fehlende Medienkonfiguration. HTTP-Tests pruefen Adminrechte und den Erhalt von Pause/Autonomie. Der Browserflow prueft die ausklappbare Anzeige; dessen Modell ist ausdruecklich ein Fixture.

Zusaetzlich wurde der alte Deploy-Testaufruf korrigiert: zentraler `_env`-Preloader, zwei parallele Testdateien und kein Laden von produktiven `.env`-Modellzugangsdateien unter `VF_TEST=1`. Die vorhandenen Assertions und Zeitlimits bleiben erhalten. Der zuvor auf der Produktions-VM fehlgeschlagene Hub-Starttest bleibt Bestandteil des Gates.

Rollback: die zugehoerige PR reversieren, nicht fremde Aenderungen verwerfen. Gespeicherte Anforderungen und Nachweise koennen fuer Diagnose bestehen bleiben. Es werden keine automatisch fortlaufenden Arbeiten ausserhalb der tatsaechlich laufenden Hub-Instanz behauptet.

## Produktionsstand nach Integration

PR #33 ist integriert und der externe Healthcheck meldet 1.60.5 / HTTP 200. Der reale Flottenaudit erkennt capabilityAutopilotAvailable=true fuer 16 Villen; 14 sind mit aktiver Autonomie fuer die Mitarbeit freigegeben, zwei abgeschlossene Villen bleiben unangetastet. Dies bedeutet nicht 14 gleichzeitig laufende Worker. 355 Tests auf der VM und 20 Browserflows sind bestanden. Keine der 16 Produkt-Endabnahmen ist belegt; die frische Master-Modellprobe bleibt mit HTTP 503 LLM_UNAVAILABLE blockiert. Alle Nachweise stehen in capability-autopilot-evidence.json.
