# Qualitätstor: fehlende Testwerkzeuge dürfen keine Endlosschleife auslösen

Stand: 02.11.2026 (v1.41.0)

## Befund

Villa #34 (Kopie von mybabes.ai) hatte 50 von 58 Aufgaben erledigt und stand
danach still. Jede Reparatur- und Verifikationsaufgabe scheiterte im
Qualitätstor mit demselben Text:

```
Qualitaetstor nicht bestanden, Retry angefordert:
Exit 127:
sh: 1: jest: not found
```

Der Agent behauptete im Ergebnistext, `jest` sei als devDependency installiert.
Das Tor konnte es nicht nutzen, weil im Projektordner kein `node_modules` lag
(beziehungsweise ohne devDependencies installiert worden war). `npm test` führt
das Test-Script über `sh` aus, und dort war kein `jest` auf dem Suchpfad.

Weil das Tor einen fehlenden Befehl wie einen roten Test behandelte, wurde die
Aufgabe immer wieder eingereiht. Erledigt blieb bei 50, die Agenten waren im
Leerlauf, die Villa meldete trotzdem „läuft".

## Änderung

`runQualityGate` in `server/agents.mjs`:

1. Erst normal `npm test`.
2. Scheitert es mit einem Hinweis auf ein fehlendes Werkzeug (`Exit 127`,
   `command not found`, `not found`, `ENOENT`) oder fehlt `node_modules`,
   wird einmal `npm install --include=dev --no-audit --no-fund` ausgeführt und
   der Test danach wiederholt.
3. Ist der Test dann grün, gilt er als bestanden; die Antwort vermerkt die
   Nachinstallation ausdrücklich (`npm test gruen nach Installation der
   Testabhaengigkeiten`).
4. Bleibt er nicht ausführbar, liefert das Tor `environment: true`. Der
   Aufrufer legt die Aufgabe dann **sofort auf FAILED** mit dem Grund und der
   Lehre „Testumgebung reparieren". Kein stilles Wiedereinreihen mehr.

## Grenzen

- Ein echter roter Test bleibt ein roter Test und wird weiter als Reparatur
  eingereiht. Nur „Werkzeug nicht ausführbar" gilt als Umgebungsproblem.
- Die Nachinstallation braucht Netz und Schreibrechte im Projektordner; im
  Zweifel scheitert sie ehrlich, statt grün zu lügen.
- Das Tor ersetzt keine inhaltliche Prüfung. Es belegt nur, dass die
  vorhandenen Tests tatsächlich laufen.
