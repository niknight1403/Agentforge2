# Wiederaufnahme

`node scripts/sprint-ledger.mjs status`

Zuerst den aktuellen GitHub-Head und die Arbeitsbranch `work/vf500-aurora` abgleichen. `backlog.json` ist die Quelle fuer Sprint-Status; `state.json` ist der lesbare Wiederaufnahme-Checkpoint. VF-0011 bis VF-0500 sind reservierte IDs und muessen vor Ausfuehrung fachlich konkretisiert werden. Sie sind keine erledigten Sprints.

Ein Abschluss wird nur mit echtem Implementierungs-Commit und bestandener Evidenz registriert:

`node scripts/sprint-ledger.mjs complete VF-NNNN COMMIT_SHA docs/sprints/evidence/VF-NNNN.json`

Rote Produktionsnachweise bleiben Blocker. Kein angeblich laufender Hintergrundprozess wird durch diesen Plan gestartet. Keine konkurrierenden Deployments. Ein UI-Screenshot belegt kein fertiges Produkt.
