# AnfragePilot — Apollo.io sicher verbinden

## Status
Die Apollo-Firmensuche ist in `pilot/src/apollo.js` integriert. Sie wird **nicht automatisch** ausgeführt und versendet keine Nachrichten. Die drei Apollo-Mock-Tests wurden im GitHub-QA-Lauf erfolgreich ausgeführt; ein echter Live-Aufruf gegen Apollo ist noch nicht nachgewiesen.

## Einmalige Secret-Einrichtung
1. Den im Chat veröffentlichten Apollo-Schlüssel in Apollo **widerrufen/rotieren** und einen neuen Schlüssel mit den minimal nötigen Rechten erstellen. Keine Master-Berechtigungen, wenn ein eingeschränkter Suchschlüssel genügt.
2. Den neuen Schlüssel nur unter **GitHub → Agentforge2 → Settings → Secrets and variables → Actions → New repository secret** speichern. Name genau: `APOLLO_API_KEY`.
3. Das Secret nicht in README, Issues, Shell-History, Quellcode oder GitHub Actions Logs schreiben.
4. Das Vorhandensein des Secrets allein startet noch keine Anfrage. Die GitHub-Verbindung kann hier kein Actions-Secret programmatisch erstellen oder dessen Inhalt auslesen.

## Lokale oder kontrollierte Ausführung
Für eine Umgebung, in der `APOLLO_API_KEY` sicher als Environment-Variable verfügbar ist:

```sh
cd pilot
npm ci
npm test
npm run apollo:preview
```

Die Vorschau liest ausschließlich Unternehmensname, Branche und öffentliche Firmenwebseite. Sie verarbeitet keine persönlichen E-Mail-Adressen oder Telefonnummern. Der Endpunkt ist die Apollo People API Search unter `POST /api/v1/mixed_people/api_search`. Laut Anbieter benötigt diese Suche 0 Credits, kann jedoch aufgrund des Apollo-Tarifs oder der Schlüsselrechte scheitern.

## Freigabe für den ersten Umsatz
- Firmeneignung manuell anhand Branche, Anzahl und Art der Anfragen prüfen.
- Öffentlich verfügbare Unternehmenswebseiten lesen, um den Produktfit zu bewerten; keine Web-Scraping-Umgehungen und keine sensiblen Daten sammeln.
- Zuerst eigene öffentliche Produktbeiträge und bestehende ausdrücklich erlaubte Geschäftskontakte verwenden.
- Für E-Mail-Werbung in Deutschland vorher die nötigen rechtlichen Grundlagen prüfen (insbesondere § 7 UWG); keine ungefragte Massenansprache.
- Keine erfundenen Kunden, Testimonials oder Umsätze.
- Einen echten Verkauf erst melden, wenn Stripe eine erfolgreiche Live-Zahlung für AnfragePilot bestätigt.

## Technische Schnittstelle
`previewApolloCompanies({apiKey, fetchImpl, location})` ist bewusst manuell und read-only; der Aufruf ist offline mockbar. Spätere Erweiterungen wie CRM-Eintrag, Leadbewertung und Follow-up benötigen eine separate ausdrückliche Freigabe und nachvollziehbare Berechtigung.
