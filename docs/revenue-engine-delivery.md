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
