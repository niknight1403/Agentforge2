# Full-Stack-Engine (Agentforge2 Worker)

Die Engine baut aus einem Satz Beschreibung eine vollstaendige Web-Anwendung:
Oberflaeche, API, Datenmodell, Authentifizierung und Rollenrechte. Sie laeuft als
Worker am bestehenden Event-Bus, veroeffentlicht jeden Phasenwechsel und legt
Checkpoints an, bevor sie ein Ergebnis als "fertig" bezeichnet.

Version: 1.62.0 · Code: `server/fullstack/` · Tests: `server/tests/fullstack-*.test.mjs`

## Was ein Bau enthaelt

| Schicht | Dateien | Inhalt |
| --- | --- | --- |
| Client | `client/src/pages`, `components/ui`, `services`, `hooks` | React + Tailwind, Seiten je Domaene, Formular mit Feldfehlern, Lade- und Fehlerzustand |
| API | `server/routes`, `server/repositories`, `server/schemas` | REST je Domaene, Validierung, standardisierte Fehler, Rechte an der Route |
| Kern | `server/lib`, `server/app.mjs`, `server/index.mjs` | Router, Body-Lesen, Fehlerbehandlung, Listenfenster |
| Auth | `server/auth/middleware.mjs`, `server/lib/jwt.mjs`, `password.mjs` | Bearer-JWT (HS256, strikte Algorithmuspruefung), scrypt-Hashing, Rollenpruefung |
| Daten | `prisma/schema.prisma`, `prisma/migrations`, `prisma/seed.mjs`, `server/db.mjs` | PostgreSQL-Schema, Migration, Seed; In-Memory-Adapter mit gleicher Schnittstelle |
| Tests | `server/tests/api.test.mjs` | 8 API-Tests: Health, Registrierung/Login/me, 401, 403, Validierung, Loeschen nur Admin, 404/JSON-Fehler |

Rollen sind fest: `User` liest, `Manager` liest und schreibt, `Admin` darf zusaetzlich loeschen.
Diese Zuordnung steht in der Route, nicht im Handler.

## PEER-Loop

1. **Planner** (`manifest.mjs`) liest den Auftrag deterministisch: bekannte Domaenen (Aufgabe, Projekt, Kunde,
   Rechnung, Buchung, Produkt, Bestellung, Ticket, Veranstaltung, ...), Zusatzfelder (Preis, Menge, Bild, Frist,
   Prioritaet, Adresse, Telefon), Beziehungen (`projectId`), Routen, Seiten, Rollen. Ergebnis ist
   `project_manifest.json` mit `digest` und `requestDigest`.
2. **Executor** (`emit.mjs`) schreibt den Dateibaum. Unsichere Pfade, Symlink-Ziele, nicht leere Verzeichnisse ohne
   `overwrite` und zu grosse Vorlagen werden verweigert.
3. **Express** (`verify.mjs`) prueft: Vollstaendigkeit, ESM-Syntax (parallel), JSX-Struktur, Vertraege (Schema,
   Repository, Routen, Migration, Modell, Seite, Waechter), Platzhalter, echte Schluessel, Host-Pfade und fuehrt die
   generierten API-Tests aus.
4. **Reviewer** (`reviewer.mjs`) repariert **nur** durch Neuschreiben der betroffenen Datei aus der Vorlage, maximal
   `maxRepairs` Runden. Alles andere wird eskaliert. Kein Fortschritt = Abbruch.

## Ereignisse und Checkpoints

Stream: `agentforge:events:stream` (aenderbar per `VF_FULLSTACK_EVENT_STREAM`).

| Ereignis | Bedeutung |
| --- | --- |
| `PROJECT_PLANNED` | Blueprint steht (Digest, Anzahl Domaenen und Routen) |
| `SCAFFOLD_GENERATED` | Dateien geschrieben (Anzahl, Blueprint-Digest) |
| `CONTAINER_TEST_FAILED` | Pruefung rot (Fehlerzahl, Testzaehlung) |
| `CONTAINER_TEST_PASSED` | Pruefung gruen inklusive API-Tests |
| `CHECKPOINT_SAVED` | Phase ist dauerhaft gesichert |
| `STREAM_COMPLETE` | Fertig mit Commit-Hash, Datei- und Testzahl |
| `STREAM_FAILED` | Abgebrochen mit Befund-Code |

Ereignisse enthalten ausschliesslich Metadaten (Whitelist in `events.mjs`). Der Auftragstext und Dateiinhalte
gelangen nie in den Stream und nie in einen Checkpoint; dort steht nur `requestDigest` (SHA-256) bzw.
`blueprintDigest`.

Checkpoints laufen ueber `saveCheckpoint()` aus `server/checkpoints.mjs`: hash-verkettet, wiederherstellbar,
zusaetzlich an die Runtime-Telemetrie gespiegelt. Phasen: `PROJECT_PLANNED`, `SCAFFOLD_GENERATED`,
`REPAIR_APPLIED` (nur bei Korrektur), `CONTAINER_TEST_PASSED`, `STREAM_COMPLETE`. Fuer die persistente Sicht
gibt es das Prisma-Modell `GeneratedProject` in `core/prisma/schema.prisma`.

## Aufruf

```bash
# Nur planen (schreibt nichts)
npm run forge -- --plan "Baue ein Notiztool mit Notizen und Kunden"

# Bauen und verifizieren
npm run forge -- "Baue ein Rechnungstool mit Kunden, Rechnungen und Preisen" --out ./out/rechnungstool --name "Rechnungstool"

# Worker am Event-Bus
npm run worker:fullstack
```

Worker-Auftrag auf dem Stream:

```json
{ "type": "fullstack.build.requested",
  "request": "Baue ein Buchungstool mit Buchungen und Kunden",
  "projectName": "Buchungswerk",
  "taskId": 42, "agentId": 7 }
```

Der Worker bestaetigt (XACK) erst nach Abschluss, holt haengende Pakete per `XAUTOCLAIM` zurueck und schreibt
seinen Zustand nach `server/data/fullstack/worker-health.json`. Ziele liegen immer unter der Arbeitsbasis
(`VF_FULLSTACK_WORKSPACE`, Standard `server/data/fullstack/projects`).

## Bewusste Technikentscheidungen

- **Kern ohne Fremdabhaengigkeiten.** Express, Prisma-Client und Vite brauchen `npm install`, das in einer
  abgeschotteten Sandbox ohne Netz nicht moeglich ist. Deshalb laeuft die generierte API auf `node:`-Modulen mit
  identischem Middleware-Aufbau (Route, Waechter, Handler, Fehler). Wer Express will, mountet `app.handler` vor
  `express.json()` - der Handler liest den Body selbst.
- **scrypt statt bcrypt.** Beides sind Passwort-KDFs; scrypt liegt in `node:crypto` und braucht keine native
  Kompilierung, ist damit in jeder Sandbox lauffaehig und testbar. Ein bcrypt-Pfad liegt als optionaler Adapter
  (`server/lib/bcrypt-adapter.mjs`) bereit, sobald `bcryptjs` installiert ist.
- **JWT selbst, aber korrekt.** HS256 mit `timingSafeEqual`, strikter `alg`-Pruefung (kein `alg: none`),
  `exp`-Pflicht und Mindestlaenge des Secrets (32 Zeichen, im Produktivbetrieb erzwungen).
- **Stufe 2 nur mit Freigabe.** Installieren und Buendeln (`npm install`, `vite build`, `prisma generate`) laeuft
  nicht automatisch. Die Engine prueft in Stufe 1 offline und ehrlich; Installation bleibt ein bewusster Schritt.

## Sandbox und Grenzen

- Tests des generierten Codes laufen ueber `server/project-execution.mjs`: in Entwicklung auf dem Host, in
  Produktion nur in einem gepinnten Docker-Image. Fehlt die Sandbox, gilt der Bau als **nicht verifiziert**
  (`SANDBOX_REQUIRED`) statt still auf dem Host zu laufen.
- Grenzen je Bau: 400 Dateien, 2 MiB je Datei, 20000 Zeichen Auftrag, 2 Reparaturrunden (einstellbar 0-5),
  10 Minuten Gesamtfrist.
- Der Reviewer kann nur Vorlagen wiederherstellen. Ein Fehler, der nicht aus dem Blueprint stammt, wird
  eskaliert - die Engine raet nicht.

## Kennzahlen fuer den Supervisor

`STREAM_COMPLETE`/`STREAM_FAILED` liefern `files`, `testsPassed`, `repairs`, `durationMs`, `commit` und `code`.
Damit sind Build-Erfolgsquote, Reparaturquote und Bauzeit ohne Zusatzinstrumentierung messbar.
