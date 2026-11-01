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

`npm run check`: 359 Tests bestanden und Webbuild bestanden vor der zusaetzlichen No-op-Regression. Anschliessend 13/13 gezielte Projektverifikationstests bestanden. Das vollstaendige Gate wird fuer den integrierten Stand erneut ausgefuehrt.
