# Zehn Sprints: zuverlässiger Villenbetrieb

Datum: 29. Oktober 2026. Ausgangsstand: e03709ce3ae1235d1eb02a74173208dae73488cd.

## Implementierte und ausführbar geprüfte Änderungen

| Sprint | Umsetzung | Nachweis |
| --- | --- | --- |
| 1 | Startoptionen werden pro Villa gehalten; wartende Starts übernehmen nicht die Optionen des letzten Aufrufers. API unterscheidet neue und bereits aktive Starts. | Scheduler- und HTTP-Integrationstest |
| 2 | Explizite endliche Läufe entfernen den gespeicherten Abschlussmodus. Resume respektiert individuelle Optionen. | Persistenz- und Wiederaufnahmetests |
| 3 | Ein Stopp invalidiert verspätete Laufergebnisse. Daraus entsteht kein neuer Modell-Retry. | Stop-Race-Test |
| 4 | Synchrone und asynchrone vorübergehende Schedulerfehler planen Wiederholungen; andere Fehler werden sichtbar als FAILED markiert. | Zwei Fehlerpfade im Scheduler-Test |
| 5 | Scheduler und Villen-API liefern Versuch, nächsten Wiederholungszeitpunkt und sicheren Grund; Web-Karten zeigen die verbleibende Wartezeit. | Status- und HTTP-Test |
| 6 | Gleichzeitige Providerfehler werden gemeinsam gezählt. Eine verspätete erfolgreiche Antwort schließt keinen inzwischen geöffneten Circuit. | Deterministischer Paralleltest |
| 7 | Begrenzte Warteschlange pro Modell-Endpunkt; volle Queues liefern BUSY statt unbegrenzt Speicher zu binden. | Kapazitäts- und Slot-Wiederverwendungstest |
| 8 | Wartende und laufende lokale Modellanfragen sind abbrechbar. Villa-Stopp reicht das Signal bis fetch weiter; unfertige Aufgaben bleiben PENDING. | Queue-Abbruch, Orchestrator- und HTTP-Integrationstest |
| 9 | Provider-Backpressure und Cooldowns bestimmen Retry-After. Der Wert bleibt über Agent, Aufgabe und Scheduler erhalten, bis maximal zehn Minuten. | 429-, Cooldown- und HTTP-Kaskadentests |
| 10 | Reguläre Deploys bewahren Villenauswahl und Autonomie. Alle Backend-Dateien lösen den zentralen Deploy aus. Die beiden früheren partiellen Deploys bleiben ausschließlich manuell aufrufbar und teilen dessen Ausführungssperre; Tests, Rollback und Healthchecks bleiben vorgeschaltet. | Deploy-Regressionstest und vollständiges check-Gate |

## Konfiguration

- `VF_LLM_MAX_QUEUE`: maximal wartende Anfragen pro Endpunkt, Standard 64, Obergrenze 512.
- `VF_LLM_LOCAL_QUEUE_WAIT_MS`: maximale lokale Slot-Wartezeit, Standard 90000 ms, Obergrenze 120000 ms; die gesamte Anfragefrist hat Vorrang.
- Einzelne lokale Provideraufrufe bleiben auf 15 Sekunden begrenzt.
- Ein Stopp beendet Modellwartezeiten und lokale laufende Modellanfragen. Bereits extern gestartete Remote-Jobs oder Werkzeuge benötigen weiterhin ihre eigenen Abbruchmechanismen.

## Qualitätsgate

`npm run check` prüft JavaScript-Syntax, Secrets, Backend-Tests und den Web-Produktionsbuild. Die neuen Tests verwenden isolierte SQLite-Dateien sowie kontrollierte HTTP-/Provider-Fixtures. Sie belegen Kontrollfluss, Zustandsübergänge und Fehlertoleranz, nicht die Verfügbarkeit oder Ergebnisqualität externer Free-Tier-Modelle.

Produktabschlüsse werden nur durch das vorhandene Produkt-Abnahmegate gemeldet. Ein laufender Agent ist kein Nachweis für ein fertiges Produkt. Kostenlose Providerquoten und vorhandene CPU-Kapazität bleiben reale Kapazitätsgrenzen.

## Verifikation dieses Sprintpakets

Lokales vollständiges Gate: 296 Tests bestanden, 0 fehlgeschlagen; Secret-Scan, JavaScript-Syntaxprüfung und Web-Produktionsbuild erfolgreich. Externe Providerverfügbarkeit und Projektabschlüsse sind davon getrennte Live-Nachweise.

Der produktive Master-Chat-Test startet nach einem erfolgreichen Hub-Deploy per workflow_run. Die frühere feste 45-Sekunden-Verzögerung wurde entfernt, damit der Test nicht während eines Neustarts läuft.

### Live-Nachbesserung: interaktiver Master bei ausgelasteten Villen

Interaktive Anfragen werden in der Modellwarteschlange bevorzugt, aber nach zwei interaktiven Freigaben kommt ein wartender Hintergrundjob zum Zug. Der Master plant mit einem strukturierten Zustand von maximal 8000 Zeichen statt abgeschnittenem Vollstatus; Skill-Bodies werden nicht mitgesendet. Vorherige Chatbeiträge sind begrenzt, die aktuelle Nutzernachricht bleibt vollständig. Das reduziert lokale Prefill-Last und verhindert Queue-Verhungern. Providerquoten werden dadurch nicht erhöht.
