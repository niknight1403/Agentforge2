# Master-Agent und Dublettenbereinigung

Der globale Chat ist im Web über „Master-Agent“ und in Android über „Master“ erreichbar. Die App braucht keine ausgewählte Villa dafür.

Beispiele:
- `Status`
- `Zeige die doppelten Villen.`
- `Archiviere doppelte Villen.`
- `Erstelle Villa "Musikstudio": Mobile Live-Performance mit niedriger Latenz`
- `Aktiviere Pack council`
- `Erstelle einen Skill Qualitätsprüfung: Prüfe Fehlerzustände und konkrete Abnahmekriterien.`
- `Setze das Vorschlagslimit auf 6.`

Freie Wünsche werden über die bereits eingerichteten KI-Routen in begrenzte Konfigurationsaktionen übersetzt. Status, genaue Dublettenbereinigung und die zitierte Villa-Anlage funktionieren ohne Modell. Neue Villen erhalten einen dauerhaften Projektauftrag und starten erst auf ausdrücklichen Wunsch. Eigene Skills ergänzen die Agenten-Anweisungen; Pack- und Werkzeugschalter wirken serverseitig.

Connectoren können öffentliche HTTPS-Endpunkte mit JSON-Antworten per GET lesen. Eine vorhandene Secret-Referenz kann ausdrücklich einem benannten Host zugeordnet werden. OAuth, MCP, neue ausführbare Werkzeugimplementierungen und beliebige Quellcodeänderungen werden dadurch nicht automatisch installiert.

Dubletten haben denselben normalisierten Namen, dasselbe Ziel und denselben Quellpfad. Behalten wird eine laufende Villa, danach die mit den meisten erledigten Aufgaben. Weitere laufende Duplikate werden übersprungen. Archivierte Villen verschwinden aus der aktiven Liste; Aufgaben, Agenten, Nachrichten, Erinnerungen und Dateien bleiben erhalten. `Stelle Villa #ID wieder her` stellt pausiert wieder her.

## Betrieb

Das tatsächliche Live-Backend liegt im Repository **AgentForge**. Android und die Studio-Weboberfläche liegen in **Agentforge2**. Beide verwenden dieselben Master-Endpunkte. Vorhandene Master-Verläufe werden beim Upgrade einmalig übernommen. Im Benutzer-Hub ist die globale Verwaltung Administratoren vorbehalten.

Vor einem Live-Update die Datenbank sichern und die Prüfungen ausführen:

```sh
node --test server/tests/*.test.mjs
```

Für eine lokale Dublettenvorschau mit explizit gesetztem `VF_DB`:

```sh
node server/scripts/cleanup-duplicates.mjs
```

`--apply` archiviert die Vorschau. Dazu den Hub zuerst anhalten, damit kein laufender Job archiviert wird; danach wieder starten. Die Ausgabe enthält Vorher-/Nachher-Zähler und die Zuordnung archivierter IDs. Das Skript prüft, dass keine Projektinhalte verschwinden. Nicht auf einer fremden oder ungesicherten Datenbank ausführen.

## Prüfstand 2026-10-15

211 lokale Tests im App-Repository und 91 im Live-Backend bestanden, darunter echte HTTP-Anfragen, Idempotenz, Inhalte-Erhaltung, wirksame Skills/Werkzeuge und die Administrator-Sperre. Syntaxprüfung und Secret-Scan im App-Repository bestanden.

GitHub Actions beendete neue Jobs bereits vor dem ersten Arbeitsschritt, auch nach erneutem Versuch. Der aktuelle Android-Build und die erweiterten Chrome-Prüfungen sind deshalb noch nicht bestätigt. Es wurde noch kein Live-Deployment und keine Bereinigung der produktiven Datenbank durchgeführt.
