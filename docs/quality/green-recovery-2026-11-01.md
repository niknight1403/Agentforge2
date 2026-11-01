# Produktions-Recovery 2026-11-01

## Reale Nachweise

- Ausgangsstand main: `16bee853539d071c6f9f7bb3b1ca56d5039f8b70`, Version 1.60.5.
- Drei vorhandene, deaktivierte kostenlose Ollama-Routen 30/31/32 wurden vor Aktivierung durch echte Inferenz geprueft (1296/1462/1590 ms). Keine bezahlten Routen, Prioritaeten oder Ressourcenquoten veraendert.
- Recovery mit Rueckroll-Artefakt: https://github.com/niknight1403/Agentforge2/actions/runs/41255761579
- Frischer Master: HTTP 200, ok true, 33 Sekunden, keine Nebenaktionen: https://github.com/niknight1403/Agentforge2/actions/runs/41249986255 (Job 124698781023).
- Read-only Produktinventar: https://github.com/niknight1403/Agentforge2/actions/runs/41256246403

## Korrekturen

Interaktive Anfragen warten hoechstens drei Sekunden pro belegtem lokalen Knoten (Standard 1500 ms), damit verfuegbare Alternativen innerhalb des vorhandenen Gesamtbudgets erreicht werden. Hintergrundlimits bleiben erhalten. Regression prueft die belegte erste und freie zweite Route.

Explizite App-/Software-Auftraege behalten Software-Abnahme, auch mit Audio-/Video-Funktionen. Ein Video ueber eine App bleibt Video. Tests unterscheiden beide Faelle.

Konstante `node -e console.log`-Erfolgsmeldungen werden als fehlender Pruefbefehl behandelt, auch in expliziten Verifikationskonfigurationen. Dies ist eine begrenzte deterministische Erkennung, kein Beweis, dass beliebiger Buildcode sinnvoll ist.

## Weiterhin rot

Alle 16 Villen haben noch keine gueltige vollstaendige Produktabnahme. Offene Aufgaben, fehlende Quellen und veraltete Build/Test/Smoke-Nachweise bleiben sichtbar. Villa 25 enthielt einen unechten Buildbefehl. Fehlende Medienprovider und Android-Produktionssignierung bleiben Blocker. Kein Release und keine Alles-gruen-Erklaerung aus diesen Teilnachweisen ableitbar.

## Lokale Pruefung

`npm run check`: 361/361 Tests, Syntax- und Secret-Scan sowie Webbuild bestanden (Exit 0). PR #34: Hub-Tests, Browser/Design-Audit, APEX und CodeQL bestanden. Integriert und mit externem HTTP 200 deployed: `6064f2f158a947e7a77e578cbd6c67a91a680d0b`.

## Nach Deploy weiterhin rot

Die frische Masterprobe antwortete HTTP 200 ohne Aktionen, beantwortete aber die vorherige Modellverbindungsfrage statt der aktuellen Start-Frage. Die Relevanzpruefung bleibt fehlgeschlagen: https://github.com/niknight1403/Agentforge2/actions/runs/41257200279 . Der fruehere erfolgreiche VF-0004-Nachweis ersetzt diesen neuen roten Nachweis nicht.

Die APK-Pipeline pruefte um 00:32:17 UTC den produktiven Chat waehrend des Deploys (lokaler Healthcheck erst 00:32:23 UTC) und scheiterte mit HTTP 502. Die automatische APK-Pipeline wird deshalb an erfolgreichen Hub-Deploy gekoppelt. Checkout und Release-Ziel verwenden dessen `head_sha`; bei neuerem main wird kein alter Build publiziert. Tag- und manuelle Ausloeser bleiben erhalten und erfordern weiterhin die produktiven Gates. Scripts-Aenderungen loesen ebenfalls Hub-Deploy aus, damit deren APK-Lauf folgen kann. Keine neuen Tokenrechte oder Secrets.

`fs-tools.mjs` startet freigegebene Projektbefehle direkt mit `execFile`; dies belegt keine Sandbox. Vor echten Builds fremden Projektcodes muss die isolierte Ausfuehrung nachgewiesen werden. Villa 5 ist ein moeglicher erster Abnahmekandidat mit vorhandenen Build/Test/Smoke-Befehlen; die Abnahme ist noch offen.

Stuendliche begrenzte Fortsetzung und Q-Gate-Pruefung sind als Automation eingerichtet. Keine kontinuierliche Codex-Ausfuehrung und keine Erfolgsbenachrichtigung vor allen Pflichtnachweisen.

Ein begrenzter Kontrolllauf nach Deploy scheiterte mit HTTP 503 nach 60.4 s: 32B-Knoten BUSY, Oracle-Inferenz TIMEOUT; weitere gepruefte lokale Knoten wurden innerhalb des Restbudgets nicht erreicht. Dies bleibt der naechste konkrete Routing-Blocker. Keine weiteren blinden Retries.

Review-Korrektur: Auch reine Aenderungen an `build-apk.yml` loesen Hub-Deploy aus und erhalten dadurch den automatischen APK-Lauf. YAML geparst, nachfolgende GitHub-Checks bleiben Pflicht.
