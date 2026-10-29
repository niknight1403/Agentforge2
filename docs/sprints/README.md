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
