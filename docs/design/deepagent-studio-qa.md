# DeepAgent Studio · Android-Designprüfung

Designziel: [ausgewählte Richtung 3](deepagent-studio-reference.webp) vom 21.11.2026. Die Referenz enthält Konzeptdaten. Die App zeigt echte Projekt-, Vorschau- und Build-Daten.

## Umsetzung

- Chat und Vorschau sind getrennt anwählbar. Ein vorhandener Web-Einstiegspunkt erscheint auf größeren Displays als kompakte Vorschau im Chat und im Vorschau-Reiter als größere Ansicht. Auf kurzen Android-Displays bleiben Chat-Eingabe, Abnahmestatus und „Build & Downloads“ ohne eingebettete WebView erreichbar.
- Die Abnahme verwendet den tatsächlichen `ready`-Status und zeigt offene Prüfungen. Ein Download wird erst bei einem fertigen Artefakt angeboten. In der Villa-Fertigstellung steht der Produkt-Build samt Status oben; die Reiter sind einzeilig und horizontal scrollbar. Lange Alternativen- und Phasenlisten lassen sich ein- und ausklappen, auch am Listenende.
- Werkzeugliste und Ereignisse bleiben einklappbar. Die Aktion „Entwicklung fortsetzen“ steht vor der langen Werkzeugliste. Bei fokussierter Chat-Eingabe verschwindet die Vorschaukarte; nach dem Senden werden Fokus und Tastatur freigegeben.
- Der Navigationszustand und ein begonnener Chat-Entwurf bleiben bei Android-Konfigurationswechseln erhalten. Repo- und Dateianhänge, Text-to-Speech und Entwicklungshandoff bleiben vorhanden. Die doppelte Topbar und der Slide-/Fade-Übergang am Chat wurden entfernt.
- Das Hub-Token wird beim Laden der Web-Vorschau nur für den eingeschränkten Preview-Pfad des jeweiligen Projekts verwendet.

## Live-Prüfung am App-Stand `9cc43bf8`

[DeepAgent Workspace CI](https://github.com/niknight1403/Agentforge2/actions/runs/45204902982) war erfolgreich: Hub-Regression, Android lint, Unit-Tests, Debug-APK und Android-Emulator-E2E. Auch die übrigen PR-Workflows einschließlich Android PR checks, CodeQL und Secret hygiene waren für diesen Commit grün.

Im Pixel-3a-Emulator (Android API 29) wurde die tatsächlich gebaute APK mit einem isolierten lokalen Hub und deterministischen Projektdaten bedient:

1. DeepAgent-Projekt öffnen, Chat/Vorschau wechseln und den ausgelieferten Web-Einstiegspunkt in der WebView sichtbar rendern.
2. Abnahmestatus und Werkzeuge öffnen; „Entwicklung fortsetzen“ bleibt erreichbar.
3. Nachricht mit geöffneter Tastatur senden, Hub-Antwort in der App sehen und die Nutzernachricht im Hub-Verlauf verifizieren.
4. Auf etwa 314 dp Breite und 640 dp Höhe wechseln. Der DeepAgent-Bereich bleibt offen; der Chat-Editor ist sichtbar. Drei schnelle Chat/Vorschau-Wechsel rendern die WebView erneut, ohne dass der App-Prozess neu startet.
5. „Build & Downloads“ öffnen. Produkt-Build-Status „noch nicht gebaut“ erscheint am Anfang der Fertigstellung; Alternativen lassen sich öffnen und am Listenende schließen.

Der Job meldete `ANDROID_DEEPAGENT_E2E_PASSED`. [Screenshots und UI-Hierarchie](https://github.com/niknight1403/Agentforge2/actions/runs/45204902982/artifacts/14833316674) sowie die [Debug-APK](https://github.com/niknight1403/Agentforge2/actions/runs/45204902982/artifacts/14832858964) sind als CI-Artefakte verfügbar.

Der Test nutzte weder Produktionsdaten noch externe LLM-Schlüssel. Das isolierte Projekt hatte absichtlich keinen fertigen Produkt-Build; ein tatsächlich erzeugter APK-Download wurde nicht geprüft. Die lange Phasenplanung wurde nicht im Emulator zu Ende bedient. Ein physisches Android-Gerät, TalkBack und ein längerer visueller Flackertest bleiben offen. Der PR bleibt Draft; es gab keinen Merge und keine Infrastrukturänderung.
