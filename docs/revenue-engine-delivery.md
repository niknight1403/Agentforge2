# Villa 3 – Autonomous Revenue Engine | Übergabestand
Datum: 2026-11-03

## Gegenstand
Bestehende Villa **#3** in `niknight1403/Agentforge2`. In Repository-Dokumenten
als „Autonomous Revenue Engine“ bezeichnet; der tatsächliche Status in der
Hub-Laufzeitdatenbank wurde **nicht** geprüft. Produktfokus: `pilot/` (AnfragePilot).

## Umgesetzt in dieser Änderung
- `villa-prompts/villa-3-revenue-engine-v3.md`: präzisierter und messbarer Master-Prompt
  mit einem Produkt, realen Umsatzzahlen, Sicherheits-/Kostenlimits, Pflicht-Tests und
  klarer Trennung zwischen Produktabnahme und echtem Umsatzziel.
- `.github/workflows/villa-prompt-apply.yml`: Standard-Prompt-Pfad auf v3
  gesetzt; der Start einer Villa ist nun ausdrücklich zu bestätigen
  (`start=false` als Standard).
- Keine Änderungen an produktiven Zahlungen, Live-Preisen oder Kundendaten.

## Verifikation (belegpflichtig)
| Gate | Status | Begründung |
| --- | --- | --- |
| GitHub-Prompt im Repository | VERIFIZIERT | Datei auf `main` gespeichert |
| Workflow-Konfiguration gespeichert | VERIFIZIERT | Datei auf `main` aktualisiert |
| Prompt in Hub-DB von Villa 3 angewendet | NICHT_VERIFIZIERT | GitHub-Workflow wurde nicht dispatcht |
| Villa 3 läuft und verarbeitet den Prompt | NICHT_VERIFIZIERT | Keine Live-DB-Inspektion |
| Unit-/Integration-/E2E-Tests des Produkts | NICHT_VERIFIZIERT | Nicht in dieser Sitzung ausgeführt |
| Live-URL inkl. Checkout, Webhook, Kündigung | NICHT_VERIFIZIERT | Keine aktuelle End-to-End-Probe |
| Stripe-Live-MRR und zahlende Kunden | NICHT_VERIFIZIERT | Keine geprüften Zahlungsdaten |
| Ziel 5.000–7.000 EUR MRR | NICHT_VERIFIZIERT | Kein realer Umsatznachweis |

## Voraussetzungen für eine tatsächliche Übergabe
1. Workflow `Villa-Prompt ausrollen (Hub-DB)` mit `villa_id=3`,
   `prompt_path=villa-prompts/villa-3-revenue-engine-v3.md` und
   bewusst gewähltem `start=true` ausführen.
2. Nachsehen, ob der Master-Prompt in der Hub-Datenbank tatsächlich als
   `CONSTRAINT` gespeichert und Villa #3 korrekt aktiv ist.
3. AnfragePilot-Test- und Live-Build-Checks inklusive echter Nutzerreise,
   Checkout/Webhook/Kündigung durchführen; Rollback-Prozedur verifizieren.
4. Stripe-Live-Transaktions-/Abo-Metriken einsehen, zwischen Brutto-/Netto-MRR,
   Steuern, Refunds und Betriebskosten unterscheiden.
5. Erst bei nachgewiesener technischer Abnahme „Produkt fertig“ melden,
   und erst bei realem Umsatz „Umsatzziel erreicht“.

## Zahlenmodell
99 EUR/Monat × 51 Kunden = 5.049 EUR **nominaler Brutto-MRR**;
99 EUR/Monat × 71 Kunden = 7.029 EUR **nominaler Brutto-MRR**.
Beide Werte sind hypothetische Szenarien, **keine Ist-Zahlen**.


## Fortschreibung 2026-11-03 — AnfragePilot Self-Service und QA

Neu auf `main`:
- `pilot/src/billing.js`: atomare Transaktion für Stripe-Webhook-Daten und Abostatus;
  Regeln für verspätete Events, doppelten Checkout und Kunden-ID-Konflikte.
- `pilot/src/server.js`: authentifizierter `POST /api/billing/portal`,
  Stripe-Kundenportal-Session mit gespeicherter Kundenzuordnung und konfiguriertem
  HTTPS-`BASIS_URL` statt unsicherem Host-Header.
- `pilot/public/dashboard.html`: Schaltfläche zur Verwaltung des Abonnements,
  der Rechnungen und der Kündigung.
- `pilot/tests/api.test.js`: Regressionstests für Rollback, Webhooks,
  Bezahlstatus, Kundenportal-Anmeldung und fehlende Stripe-Kunden.
- `.github/workflows/pilot-revenue-qa.yml`: Tests für `pilot/`
  bei Push und Pull Request.

### Abnahmefakten
- Repository-Dateien und Commits wurden über GitHub erneut abgerufen.
- GitHub Combined Status zeigte keine Statuskontexte; die verwendete
  Workflow-Run-Abfrage zeigte keine bestätigten Pull-Request-Läufe für die
  geprüften Commits. Das beweist **keinen** grünen Testlauf.
- Die öffentliche AnfragePilot-URL und Health-Adresse waren in der externen
  Prüfoberfläche nicht abrufbar. Produktions-Deployment bleibt UNVERIFIZIERT.
- Der angeschlossene Stripe-Live-Account ist auslesbar; eine genaue Zuordnung
  seiner Kennzahlen zu AnfragePilot und ein verifizierter Ziel-MRR liegen
  bislang nicht vor. Einnahmen werden daher **nicht** als erreicht ausgewiesen.
- Die Hub-Laufzeitdatenbank von Villa #3 und der Prompt-Ausrollungsstatus
  wurden nicht live verifiziert.

### Ausstehende Release-Gates
1. `cd pilot && npm ci && npm test && npm run check` auf zugänglichem Runner,
   mit Testprotokoll und Commit-SHA.
2. Stripe-Testmode: Checkout, signierte Webhooks, wiederholte und verspätete
   Zustellungen, Portal und Kündigung Ende-zu-Ende testen.
3. Produktion: URL, TLS, Authentifizierung, Session-Cookies, Dashboard,
   API-Kontingente, Datenschutz, Sicherung und Rollback prüfen.
4. Stripe-Live: nur real nachgewiesene AnfragePilot-Abonnements zur Berechnung
   der Brutto-/Netto-MRR heranziehen. Keine echten Zahlungen zum Testen auslösen.
5. Villa #3: Hub-DB-Prompt v3, Scheduler und Aufgabenausführung nachweisen.

Diese Fortschreibung ist eine Statusdokumentation und **keine**
Produktionserfolgserklärung.


## Fortschreibung: Schutz vor alten Abo-Ereignissen, 2026-11-03

- `pilot/src/billing.js`: später eintreffende Kündigungen eines anderen
  Stripe-Abonnements können ein inzwischen aktives anderes Abo nicht
  mehr überschreiben. Fremde Subscription-Updates zum bereits aktiven
  Nutzer werden zur manuellen Prüfung abgewiesen.
- `pilot/tests/api.test.js`: zwei gezielte Regressionstests ergänzt.
- JavaScript-Syntax der Dateien `pilot/src/billing.js`,
  `pilot/src/server.js`, `pilot/src/db.js`, `pilot/src/auth.js`
  und `pilot/tests/api.test.js` ohne Syntaxfehler geparst
  (Modulimporte für die isolierte Syntaxprüfung entfernt).
- Diese isolierte Syntaxprüfung ist **kein** ausgeführter Node-Testlauf,
  kein Stripe-Testmode-End-to-End-Lauf und kein Produktionsnachweis.
- GitHub Combined-Status lieferte keine Checks für den geprüften Commit;
  der verfügbare Workflow-Run-Endpunkt erfasst nur PR-bezogene Runs und
  ergab keinen Lauf. **CI bleibt NICHT_VERIFIZIERT.**

Offen bleiben: vollständige `npm test`-Ausführung, sichere
Deployment-Abnahme, Villa-#3-Hub-Status, Live-Stripe-Produktzuordnung
und nachweislicher Zielumsatz.


## Produktionsnachweis vom 2026-11-03: AnfragePilot Stripe repariert

Der aktuelle Betriebsnachweis beruht auf abgeschlossenen GitHub-Actions-Läufen,
nicht nur auf eingecheckten Dateien:

- **AnfragePilot CI:** 48/48 Tests, 0 Fehler im Revenue-Product-QA-Workflow
  nach Ergänzung des Webhook-Readiness-Guards.
- **Produktionscode:** `src/server.js`, `src/billing.js`, `src/db.js`
  und `public/dashboard.html` stimmen SHA-256-genau mit dem geprüften
  GitHub-Release überein. Nachweis:
  https://github.com/niknight1403/Agentforge2/actions/runs/41586716006
- **Live-Preise:** Die vorhandenen Stripe-Preise 49, 99 und 199 EUR/Monat
  wurden verifiziert, die vorher fehlende sichere Laufzeitschlüssel- und
  Tarifzuordnung wurde auf der VM wiederhergestellt. Nachweis:
  https://github.com/niknight1403/Agentforge2/actions/runs/41585734847
- **Webhook-Signing:** Signierte lokale Testzustellung (ohne Zahlungs-,
  Kunden- oder Abodaten), Dienst-Health und öffentliche Kaufbarkeitsprüfung
  erfolgreich. Neuer Stripe-Webhooks-Endpunkt aktiviert; der alte Endpunkt
  und fehlgeschlagene Ersatz-Endpunkte sind deaktiviert. Nachweis:
  https://github.com/niknight1403/Agentforge2/actions/runs/41588590158
- **Stripe-Live-API:** Es wurde gesondert bestätigt, dass an
  `https://hub.cybersarah-ki.com/pilot/api/billing/webhook` genau
  ein aktivierter Webhook mit den fünf vorgesehenen Abo-/Zahlungsereignissen
  existiert.

**Freigabegrenze:** Dieser Befund bestätigt Webhook-Signaturverarbeitung
und betriebliche Konfiguration, jedoch noch **keinen** vollständigen
echten Stripe-End-to-End-Abonnementlebenszyklus (Checkout, tatsächliche
Zahlungsbestätigung, Rechnung, Rückerstattung/Kündigung). Keine Test- oder
simulierten Zahlungen als Live-Umsatz anrechnen.

**Weiter offen:** Hub-Laufzeitstatus und tatsächlich angewandter Villa-3-
Master-Prompt, verifizierte Kundengewinnung, reale aktive zahlende
AnfragePilot-Abos, belastbare Brutto-/Netto-MRR-Berechnung sowie rechtliche
und operative Produktfreigabe. Umsatz-Ziel 5.000–7.000 EUR/Monat
ist **NICHT_VERIFIZIERT**.
