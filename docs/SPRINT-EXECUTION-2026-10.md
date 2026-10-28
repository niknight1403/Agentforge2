# Agentforge2: zehn autonome Runtime-Sprints

Stand: 2026-10-28. Die zehn Arbeitspakete wurden nacheinander umgesetzt und nach `main` übertragen.

| Sprint | Ergebnis | Nachweis |
|---|---|---|
| 1. Event-Mesh | Redis Streams, Consumer Groups, Outbox und Worker-Runtime | Runtime-Build; PostgreSQL/Redis-Integrationstest in CI aktiviert |
| 2. Persistenz | Prisma-Modelle und Migrationen für Tasks, Schritte, Checkpoints, Outbox und Telemetrie | `prisma validate`; Migration entspricht dem Prisma-Schema |
| 3. Wiederanlauf | Hash-verkettete Checkpoints, Idempotenz, stale-task Recovery und begrenzte Consumer-Übernahme | Runtime-Unit-Tests; Worker-Recovery integriert |
| 4. Supervisor | Wiederholte unveränderte Werkzeugaufrufe erhalten zuerst eine Strategiekorrektur; der Abbruch erfolgt erst nach weiteren Wiederholungen | Regressionstest in `reflection.test.mjs` |
| 5. Provider-Fallback | Supervisor-Hinweis und bevorzugtes Modell erreichen den Hub; freie/konfigurierte Routen bleiben maßgeblich | Route-Reihenfolge und Hub-Executor getestet |
| 6. Task-API | Eingabelängen, JSON-Form, Idempotency-Key, Checkpoint-Form und Fehlerantworten validiert | TypeScript-Build und Hub-Suite |
| 7. Telemetrie | Allowlist für Lifecycle-Metadaten, persistente Ereignisse und 30-Tage-Bereinigung | Runtime-Tests; Integrationstest prüft gespeichertes Abschlussereignis |
| 8. Sicherheit | Interne Hub-Verbindung schützt Tokens vor unsicherem HTTP/URL-Credentials; Prisma-Transitive CVE behoben | `npm audit` ohne Befunde; Prisma-Generierung und Tests |
| 9. CI und Container | PostgreSQL-/Redis-Serviceintegration, Migration, Unit-/Integrationstests, Docker-Targets und Compose-Konfiguration in CI | Workflow auf Push/PR eingerichtet; YAML lokal geparst |
| 10. Release-Bereitschaft | Alle Änderungen auf `main`, Start-/Secret-Anforderungen und Prüfablauf dokumentiert | Lokale Gates bestanden; externer Infrastruktur- und Release-Nachweis bleibt ausstehend |

## Lokale Verifikation

- Hub: 192 Tests bestanden, Web-Produktionsbuild erfolgreich.
- Runtime: 9 Unit-Tests bestanden; 1 PostgreSQL-/Redis-Integrationstest wurde lokal übersprungen, weil die Dienste hier nicht laufen.
- Prisma: Schema gültig; Initialmigration entspricht dem Schema.
- Runtime-Abhängigkeiten: `npm audit --audit-level=high` meldet 0 Schwachstellen.
- Compose und GitHub-Workflow: YAML lokal gültig.

## Noch erforderlicher Betriebsnachweis

GitHub Actions ist für den vollständigen PostgreSQL-/Redis- und Docker-Lauf konfiguriert. Der verfügbare GitHub-Connector liefert für Push-Commits keine Actions-Check-Runs, daher ist der Remote-Lauf nicht unabhängig als grün bestätigt. Für einen echten Stackstart werden die CyberSarah-Control-Center-Codebase neben Agentforge2 sowie getrennte Werte für `MESH_POSTGRES_PASSWORD`, `AGENTFORGE_TELEMETRY_TOKEN` und `AGENTFORGE_MESH_TOKEN` benötigt. Es wurde kein Release erzeugt, solange dieser Betriebsnachweis fehlt.
