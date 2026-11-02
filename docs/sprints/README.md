# Wiederaufnahme

`node scripts/sprint-ledger.mjs status`

Zuerst den aktuellen GitHub-Head und die Arbeitsbranch `work/vf500-aurora` abgleichen. `backlog.json` ist die Quelle fuer Sprint-Status; `state.json` ist der lesbare Wiederaufnahme-Checkpoint. VF-0011 bis VF-0500 sind reservierte IDs und muessen vor Ausfuehrung fachlich konkretisiert werden. Sie sind keine erledigten Sprints.

Ein Abschluss wird nur mit echtem Implementierungs-Commit und bestandener Evidenz registriert:

`node scripts/sprint-ledger.mjs complete VF-NNNN COMMIT_SHA docs/sprints/evidence/VF-NNNN.json`

Rote Produktionsnachweise bleiben Blocker. Kein angeblich laufender Hintergrundprozess wird durch diesen Plan gestartet. Keine konkurrierenden Deployments. Ein UI-Screenshot belegt kein fertiges Produkt.

## Produktions-Checkpoint 29.10.2026

Implementierung 1.60.0 ist mit PR #31 in `main` integriert (29801696136f633c5fc7fed6105e1db077138782). Sieben Ziele sind abgeschlossen: VF-0001, VF-0002, VF-0003 und VF-0005 bis VF-0008. Kein weiterer Sprint wird aus einem erneut gestarteten Test gezaehlt.

Die produktive Master-Probe meldet weiterhin HTTP 503 / LLM_UNAVAILABLE. Die erweiterte Diagnose zeigt Cloud-Cooldowns und lokale TIMEOUT/BUSY. Alle zehn gelesenen Produktkandidaten sind unverified, mit offenen Aufgaben und Blockern. Vorhandene Archive sind deshalb noch keine Produktabnahme. Details stehen in `evidence/VF-0004-blocked.json` und `evidence/VF-0009-blocked.json`.

Naechster konkreter Schritt nach Laden des aktuellen Heads:

1. `node scripts/sprint-ledger.mjs status`
2. Provider-Cooldowns und aktuelle Workflow-Ergebnisse lesen. Genau eine Master-Chat-Probe ueber den vorhandenen Workflow mit GitHub Secrets ausloesen, z. B. `gh workflow run master-chat-probe.yml --ref main`.
3. Bei weiterem Fehler einen konfigurierten Endpoint mit begrenztem Timeout isoliert pruefen. Keine Keys auslesen, keine Quoten umgehen, keine bezahlte Route freischalten.
4. Erst nach echter Modellantwort VF-0004 abschliessen. Dann ein bestehendes Produkt anhand seiner realen Blocker fertigstellen und Nutzerfluss plus Download pruefen (VF-0009).
5. Release-Gates auf demselben Code-Commit erneut ausfuehren. Bestehende Android-Debug-Signierung separat durch eine dauerhaft verwaltete Produktionssignierung ersetzen, bevor Update-Kompatibilitaet zugesagt wird.

Dieser Checkpoint startet keinen unbeaufsichtigten Hintergrunddienst.

Abschlussbefund: Release-Smoke Run 40958119898 bestand die echte Modellstufe und scheiterte anschliessend am Produktgate. Die getrennte Master-Probe Run 40959050138 scheiterte danach erneut mit HTTP 503 nach 39.9s. VF-0004 bleibt deshalb blocked; keine weiteren blinden Gesamt-Retries. APK- und Web-Archive sind in evidence/VF-0010-blocked.json mit SHA-256, Groesse und echten GitHub-Artefaktlinks dokumentiert. Es wurde kein v1.60.0-Release publiziert.

## Letzter integrierter Wartungsstand

PR #32 und #33: Konfiguration/Prompts und Faehigkeiten-Autopilot, Version 1.60.5, Runtime-Commit b7c3a43da5c661a31de7f6f61068ac93d18e74d1. 355 Tests auf CI und Produktions-VM bestanden; 20 Browserflows bestanden. Der neue Autopilot ist per realer Hub-API nachgewiesen. Diese Arbeiten werden nicht als 500 abgeschlossene Sprints umgedeutet.

Die letzte Master-Probe (Run 41249986255, zweiter begrenzter Versuch) ist HTTP 503 LLM_UNAVAILABLE nach 60.5s; der vollstaendige Flottenaudit erfasst 16 Villen ohne bestandene Produkt-Endabnahme. Details und Quellen: docs/quality/capability-autopilot-evidence.json. Der Codex-Sprintplan laeuft nicht selbststaendig weiter; ausschliesslich der bereits laufende Hub verarbeitet seine aktivierten Villen innerhalb der dokumentierten Grenzen.

## Produktionsdiagnose 2. November 2026

Der letzte erfolgreiche Hub-Deploy ist Run 41513872263 auf Commit `6aacb3e62ea4210eb8bc1d801c96783077115e2a`. Die automatisch folgende APK-Pipeline scheitert weiterhin am unveraenderten Produkt-Abnahmegate (Runs 41513791102 und 41514485527); es wurde keine Release-Freigabe behauptet.

Die lesende Produktdiagnose Run 41515290424 zaehlte 18 Villen. `GET /api/villas` liefert laut Implementierung alle nicht archivierten Zeilen ohne SQL-Limit/Pagination, nach Erstellungszeit absteigend. Das Release-Smoke sortiert lokal nach `tasks_done` und prueft hoechstens zehn Kandidaten. Der Diagnose-Run sah fuer alle 18 `verified=false`; die ersten zehn hatten zwar `build.status=ready`, aber damit ist kein Produkt abgenommen. Ursache ist somit derzeit das Fehlen eines verifizierten Produkts, nicht ein nachgewiesener abgeschnittener Listen-Response.

Ein zusaetzlicher bestaetigter Infrastrukturblocker: Produktion verweigert Projektpruefungen ohne die gepinnte Docker-Sandbox (`PROJECT_SANDBOX_REQUIRED`). Der vorhandene Produktionsnachweis fuer Villa 34 nennt fehlendes `next`/`jest`; der Hub-Deploy konfiguriert weder `VF_PROJECT_SANDBOX=docker` noch ein unveraenderliches Image. Erforderlicher Handoff: Der Produktions-/Infrastruktur-Owner muss Docker und ein lokal vorhandenes Image mit Digest bereitstellen, die beiden Werte ueber den freigegebenen Host-Konfigurationsweg setzen und die bestehenden Isolation-, Build-, Test- und Smoke-Pruefungen ausfuehren. Bis dahin weder Host-Ausfuehrung freischalten noch Image nachladen oder erneut deployen.

Sprint VF-0011 ergaenzt eine strukturierte, datensparsame Fehlerdiagnose fuer Listenform/Pagination, Kandidatenauswahl, Produktblocker-Kategorien, Buildstatus und Download/ZIP-Fehler. Alle Release-Kriterien bleiben fail-closed. Evidenz und lokale Tests stehen in `evidence/VF-0011-diagnosis.json`. Der Code-Sprint ist abgeschlossen; PR-Review/Integration und Produktionsabnahme bleiben separat offen. Kein neuer Produktions-Deploy wurde ausgeloest.

VF-0011 ist mit Commit `dd94ca3a0f9e25d677a8ddcfbc325f1d572388a2` implementiert; alle PR-CI-Pruefungen sind gruen. PR #68 ist noch offen, es gab keine Produktionsintegration oder keinen Deploy. VF-0012 fuegt `node scripts/check-project-sandbox.mjs` als nicht-invasive Vorpruefung hinzu. Sie kontrolliert nur den expliziten Docker-Modus, ein digest-gepinntes Image und dessen lokale Praesenz; sie startet keinen Container und laedt kein Image. Auf der aktuellen Maschine meldet sie erwartungsgemaess `PROJECT_SANDBOX_REQUIRED`. Das ist ein belegter Konfigurationsfehler, keine Produktionsbereitschaft und kein Ersatz fuer spaetere Isolationstests. Details: `evidence/VF-0012-sandbox-preflight.json`.

VF-0012 ist mit Commit `49b95f727c7fa0a98f0683649aa6b8171b2c12f3` und 7/7 gezielten Tests abgeschlossen. Hub-Tests, Syntax, Browser-Audit/E2E, CodeQL und Verify sind im PR gruen; der erste Browser-Audit-Anlauf war ein temporaerer Chrome-DevTools-Startfehler und der Retry bestand. Auf Windows scheitert der komplette lokale Lauf an fehlendem Python und verweigerten Symlink-Rechten; Linux-CI ist gruen. Kein Production-Deploy wurde ausgeloest.

VF-0013 adressiert die in `evidence/VF-0010-blocked.json` bestaetigte Debug-Signatur: Release-APK und AAB verlangen jetzt einen dedizierten Produktionsschluessel aus GitHub Secrets und brechen bei fehlender Konfiguration ab. Der Android-PR-Workflow prueft zusaetzlich, dass der signaturlose Release-Build aus genau diesem Guard scheitert und kein APK erzeugt. Der Runner-Keystore liegt temporaer mit Modus 0600; das Produktgate bleibt vor GitHub-Release-Publikation. Die echten Signatur-Secrets sind nicht vorhanden/geprueft und muessen durch den Release-Owner eingerichtet werden. Es wurde kein Release-Build und kein Deploy ausgeloest; der neue negative Buildtest wartet auf Linux-CI.

VF-0014 schliesst eine weitere belegte Verifikationsluecke in der neuen Sandbox-Vorpruefung: Die Unit-Tests faken Docker-Inspect bisher. Der vorhandene `Project Sandbox Integration`-Workflow ruft die CLI nun nach dem Pull seines CI-Testimages mit dessen aufgeloestem Digest auf. Das verifiziert den echten lokalen `docker image inspect`-Pfad, ohne dass die Vorpruefung pullt oder Container startet. Der Lauf wartet auf PR-CI; Produktion wird nicht beruehrt.
