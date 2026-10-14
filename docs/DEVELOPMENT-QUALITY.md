# UI und Entwicklungsqualität

Der Studio-Umbau verbessert das Web-Control-Center und die gemeinsame Android-Oberfläche. Die bestehenden Hub-APIs und Entwicklungsabläufe bleiben kompatibel.

## Änderungen

- Desktop-Navigation, responsive Projektkarten, Suche, Statusfilter und natürliche Sortierung.
- Globale Kennzahlen aus `/api/stats`; `tasks.done` zählt tatsächlich erledigte Aufgaben. Ein geöffnetes Projekt überschreibt die globalen Werte nicht mehr.
- Tastaturbedienbare Reiter, isolierter Dialoghintergrund, Fokus-Rückgabe, Sprunglink und echte SSE-Verbindungsanzeige.
- Fehler- und Leerzustände mit Wiederholung bzw. Filter-Reset; veraltete Listenantworten überschreiben keine neuen Daten.
- Gemeinsame Android-Palette und Karten, NavigationRail ab 840 dp, System-Zurück, gespeicherte Formulare und Filter, Zahleneingabe mit Validierung.
- Listenaktualisierung nur im Vordergrund und mit dem aktuellen Verbindungszustand; leere Offline-Listen zeigen eine Erklärung statt eines dauerhaften Ladeskeletts.

## Lokale Prüfung

```sh
npm run check
```

Prüft die Syntax sämtlicher JavaScript-Dateien, den bestehenden Secret-Scan und alle Unit-/Integrationstests. Die neue reine Listenfunktion wird mit unveränderlichen API-Snapshots geprüft.

```sh
npm run test:design
npm run test:live
```

Diese Prüfungen benötigen Chrome (`VF_CHROME` kann den Pfad angeben). Der Design-Audit prüft Dashboard und alle Arbeitsbereich-Reiter bei 320, 390, 768 und 1440 px. Die E2E-Prüfung umfasst Suche, Reset, Tastaturreiter und Fokus-Rückgabe.

```sh
gradle :app:lintDebug :app:testDebugUnitTest :app:assembleRelease
```

Benötigt JDK 17, Gradle 8.7 und das Android-SDK. Die APK verwendet weiterhin die vorhandene Debug-Signatur und ist kein Play-Store-Release.

## Pull Requests

Hub-, Browser- und Android-Workflows laufen auch bei Pull Requests. Sie haben Zeitlimits, minimale Leserechte und brechen überholte Läufe ab. Android-Prüfberichte und Browser-Screenshots werden als Actions-Artefakte gesichert. Der APK-Workflow ruft keine echten LLM-Provider mehr auf.

Zum Zeitpunkt der lokalen Umsetzung bestehen 184 Tests; Syntax und Secret-Scan sind grün. Android-Build und gerenderte Browserprüfung sind lokal nicht bestätigt: Gradle/Android-SDK fehlen, und der Browser-Download ist in dieser Umgebung fehlgeschlagen. Diese Ergebnisse müssen in Actions geprüft werden, bevor der Umbau als vollständig grün gilt.
