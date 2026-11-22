# DeepAgent Studio · Android-Designprüfung

Designziel: [ausgewählte Richtung 3](deepagent-studio-reference.webp) vom 21.11.2026. Die Referenz enthält Konzeptdaten. Die App zeigt nur echte Projekt-, Vorschau- und Build-Daten.

## Umsetzung

- Chat und Vorschau sind getrennt anwählbar. Ein vorhandener Web-Einstiegspunkt erscheint als kompakte Vorschau im Chat und als größere Ansicht im Vorschau-Tab. Die Statuszeile nennt dies ausdrücklich „Webansicht verfügbar“, nicht „Build fertig“.
- Die Abnahme verwendet den tatsächlichen `ready`-Status und zeigt offene Prüfungen. „Build & Downloads“ erscheint bei verknüpfter Villa und öffnet deren vorhandene Fertigstellungsansicht; ein Download wird erst bei einem fertigen Artefakt angeboten.
- Werkzeugliste und Ereignisse bleiben einklappbar. Die Aktion „Entwicklung fortsetzen“ steht vor der langen Werkzeugliste.
- Bei fokussierter Chat-Eingabe wird die Vorschaukarte ausgeblendet, damit der Senden-Button auf kleinen Android-Displays erreichbar ist. Nach dem Senden werden Fokus und Tastatur freigegeben.
- Repo- und Dateianhänge, Text-to-Speech und Entwicklungshandoff bleiben erhalten. Die doppelte Topbar und der Slide-/Fade-Übergang am Chat wurden entfernt; die Rücknavigation aus der Fertigstellungsansicht führt wieder zum DeepAgent-Chat.
- Das Hub-Token wird beim Laden der Web-Vorschau nur für den eingeschränkten Preview-Pfad des jeweiligen Projekts verwendet.

## Live-Prüfung auf PR-Kopf `e47eb75d`

[DeepAgent Workspace CI](https://github.com/niknight1403/Agentforge2/actions/runs/45055140539) ist erfolgreich: Hub-Regression, Android lint, Unit-Tests, Debug-APK und Android-Emulator-E2E. Die restlichen PR-Checks einschließlich Android PR checks, CodeQL und Secret hygiene sind ebenfalls grün.

Im Emulator (Pixel 3a, Android API 29) wurde die tatsächlich gebaute APK mit einem isolierten lokalen Hub und einem deterministischen Projekt bedient:

1. DeepAgent-Projekt öffnen und zwischen Chat und Vorschau wechseln.
2. Den ausgelieferten Web-Einstiegspunkt in der WebView sichtbar rendern.
3. Abnahmestatus und Werkzeuge öffnen; „Entwicklung fortsetzen“ bleibt erreichbar.
4. Eingabe fokussieren, Nachricht senden, Hub-Antwort in der App sehen und die Nutzernachricht im Hub-Verlauf verifizieren.
5. „Build & Downloads“ öffnen und den Produkt-Build-Status im Bereich „Fertigstellung“ sehen.

Der Job meldete `ANDROID_DEEPAGENT_E2E_PASSED`. [Screenshots und UI-Hierarchie](https://github.com/niknight1403/Agentforge2/actions/runs/45055140539/artifacts/14767043400) sowie die [Debug-APK](https://github.com/niknight1403/Agentforge2/actions/runs/45055140539/artifacts/14766988275) sind als CI-Artefakte verfügbar.

Der Test nutzte weder Produktionsdaten noch externe LLM-Schlüssel. Das isolierte Projekt hatte absichtlich keinen fertigen Produkt-Build; der Download eines tatsächlich erzeugten APK-Artefakts wurde hier nicht geprüft. Ein physisches Android-Gerät, TalkBack-Prüfung, weitere Displaygrößen und ein längerer visueller Flackertest bleiben offen. Der PR bleibt Draft; es gab keinen Merge und keine Infrastrukturänderung.
