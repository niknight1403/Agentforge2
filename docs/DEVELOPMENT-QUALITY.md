# Entwicklungsqualität und Integrationen

VillaForge hält die Laufzeit frei von npm-Abhängigkeiten. Prüfungen und Release-Automation verwenden reproduzierbare, getrennte Gates, damit neue Integrationen nicht unbemerkt Kosten, Schlüssel oder Nutzerinhalte nach außen geben.

## Lokale Qualitätsprüfung

```sh
npm run check
```

Der Sammelcheck führt Syntaxprüfungen aller JavaScript-Dateien in `server/` und `scripts/`, Secret-Scan, sämtliche Node-Unit-/Integrationstests und den Web-Produktionsbuild nacheinander aus. Der erste fehlgeschlagene Schritt beendet den Check mit Fehlerstatus.

Für gerenderte Oberflächen und echte Interaktionen:

```sh
npm run test:design
npm run test:live
```

Die browserbasierten Prüfungen brauchen Chrome oder Chromium (`VF_CHROME` kann den Programmpfad vorgeben). Sie verwenden einen lokalen deterministischen Modellstub statt externer LLM-Schlüssel, prüfen vier Viewportgrößen, Kontrast, Fokus, Überläufe und wichtige Arbeitsabläufe; CI bewahrt Berichte und Screenshots als Workflow-Artefakte auf.

Android:

```sh
gradle :app:lintDebug :app:testDebugUnitTest :app:assembleRelease --no-daemon
```

Benötigt JDK 17, Gradle 8.7 und das Android-SDK. Die veröffentlichte APK bleibt debug-signiert und ist nicht für den Play Store signiert.

## Automatische GitHub-Gates

- `Hub-Tests`: vollständiger Sammelcheck bei Pull Requests und relevanten `main`-Änderungen.
- `Live-Test & Design-Audit`: echter Browserlauf bei Änderungen an Hub, Web-UI und Prüfskripten; Berichte und Screenshots werden aufbewahrt.
- `Android PR checks`: Android-Lint, Unit-Tests und Debug-Build für App-Änderungen.
- `CodeQL Security Analysis`: JavaScript/TypeScript, Kotlin/Java und GitHub-Actions-Workflows bei Änderungen sowie wöchentlich.
- `Dependabot`: gruppierte wöchentliche Updates für Android/Gradle und GitHub-Actions; jede Änderung durchläuft die passenden Gates.
- `Build Android APK`: Lint, Android-Unit-Tests, optimierter APK-Build, Web-Produktionsbuild und signierte Build-Provenienz für beide Release-Dateien.
- `Hub-Deploy`: produktives Update und anschließende externe Erreichbarkeits-/Health-Prüfung.

## Integrationsentscheidungen

Die wichtigsten Integrationsmöglichkeiten und ihre Grenzen sind in [QUALITY-INTEGRATIONS.md](QUALITY-INTEGRATIONS.md) dokumentiert. Für neue Provider oder Dienste gelten dieselben Grundsätze: optionale Konfiguration, keine Zugangsdaten im Quelltext, keine externen Modellaufrufe im Standard-CI und Tests für Ausfallverhalten.
