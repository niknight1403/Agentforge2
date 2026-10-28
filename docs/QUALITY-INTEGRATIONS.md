# Integrationsprüfung für Entwicklungsqualität

Stand: VillaForge 1.57.0. Priorisiert wurden Integrationen, die Fehler vor dem Release finden, die installierbaren Artefakte nachvollziehbar machen und ohne bezahlte Zusatzdienste nutzbar sind.

| Bereich | Entscheidung | Nutzen / Betriebsgrenze |
|---|---|---|
| GitHub Actions | Aktiv, erweitert | Ein reproduzierbarer Node/Web-Qualitätscheck plus getrennte Browser- und Android-Gates. Laufende Commits brechen überholte CI-Läufe ab. |
| CodeQL | Aktiv | Statische Sicherheitsanalyse für JavaScript/TypeScript, Kotlin/Java und Actions-Workflows; bei PRs, relevanten Pushes und wöchentlich. Kotlin wird mit dem vom Projekt benötigten Gradle 8.7 instrumentiert gebaut. Ergebnisse sind Security-Alerts, kein behaupteter Beweis für Fehlerfreiheit. |
| Dependabot | Aktiv | Wöchentliche, gruppierte Updates für Gradle/Android und Actions. Das Projekt hat keine npm-Runtime-Abhängigkeiten; daher wird keine künstliche npm-Abhängigkeitskette eingeführt. |
| Browser- und UX-Prüfung | Aktiv, automatisch | Das vorhandene CDP-Testwerkzeug ohne npm-Pakete prüft gerenderte Layouts, Bedienabläufe, Tastatur/Fokus und Screenshots. Ein lokaler deterministischer Modellstub unterstützt Erstellungs- und Chatflüsse ohne echte Providerkontingente. Ein echter Chrome-Lauf ist nötig; die Checks laufen bei relevanten Änderungen. |
| Build-Provenienz | Aktiv | APK und Web-ZIP erhalten GitHub/Sigstore-Attestierungen, die Herkunft, Workflow und Quell-Commit nachvollziehbar verbinden. Das ist eine Lieferkettenaussage, keine Sicherheitsgarantie. |
| Kostenbewusste LLM-Routen | Aktiv | Die vorhandene lokale-/Free-Only-Kaskade und ehrliche Ausfallbehandlung bleiben Standard; der CI-Check ruft keine externen Modelle auf. Anbieter-Freikontingente sind variabel und kein unbegrenztes 24/7-Versprechen. |
| HTTP-JSON-Connectoren | Aktiv, begrenzt | Vorhandener GET-Adapter erlaubt öffentliche HTTPS-Ziele, blockiert private Ziele und nutzt Secret-Referenzen. OAuth, beliebige MCP-Schreibwerkzeuge und ungeprüfte Tool-Server werden nicht automatisch freigegeben. |
| OpenTelemetry / Langfuse / Sentry | Nicht automatisch aktiviert | Ein Exportziel, Datenaufbewahrung und Prompt-/PII-Redaktion müssten zuerst festgelegt werden. Ohne diese Vorgaben könnte Telemetrie vertrauliche Prompts oder Quelltext übertragen. Bei freigegebenem OTLP-Endpunkt kann später eine optionale, redigierte Trace-Integration folgen. |
| Externe Bild-/Video-/Audio-APIs | Optional | Medienrouten brauchen anbieterbezogene Schlüssel und Kontingente. Sie sind kein stiller Bestandteil der Entwicklungs-CI; fehlende Schlüssel müssen als fehlende Fähigkeit erscheinen, nicht als erfundene Ausgabe. |

## Eingesetzte offizielle Bausteine

- GitHub dokumentiert [CodeQL Code Scanning](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning) für Sicherheits- und Fehleranalyse über Actions.
- GitHub [Artifact Attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations) verbinden signierte Build-Provenienz mit herunterladbaren Artefakten.
- Das OpenTelemetry-Projekt beschreibt die optionale [Node.js-Instrumentierung](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/); Export bleibt bis zur abgesicherten Ziel- und Redaktionskonfiguration deaktiviert.
