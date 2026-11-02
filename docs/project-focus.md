# Projekt-Fokus: erst die priorisierten Projekte fertigstellen

Stand: 02.11.2026

## Warum

Der Hub kann mehrere Villen parallel führen. Bei sechs Slots und vielen offenen
Ideen entstehen dadurch viele halbfertige Projekte statt weniger brauchbarer.
Nikos Auftrag vom 02.11.2026: die Villen **#34** (Kopie von mybabes.ai) und
**#3** (Autonomous Revenue Engine) sollen ihr Projekt erst fertigstellen; alle
anderen Villen starten erst danach.

## Was der Fokus tut

- Solange ein Fokus steht, starten **nur** die Fokus-Villen, automatisch wie
  manuell. Andere Villen werden mit `409` und `code: "FOCUS_ACTIVE"`
  abgelehnt; sie landen auch nicht in der Warteschlange.
- Der Fokus **bricht nichts ab**. Laufende Arbeit anderer Villen wird nur dann
  angehalten, wenn das ausdrücklich jemand tut (`POST /api/villas/:id/stop`).
- Der Fokus **löst sich selbst auf**, sobald jede Fokus-Villa fertig ist.
  Ein vergessener Fokus kann den Betrieb also nicht dauerhaft sperren.

Fertig heißt: Status `COMPLETED`, oder es gibt keine offene Aufgabe mehr
(`PENDING`, `READY`, `RUNNING`) und die Villa hängt nicht in `RUNNING`,
`PAUSED`, `WAITING_FOR_MODEL` oder `STOPPING`.

## Bedienung

| Zweck | Aufruf |
| --- | --- |
| Stand ansehen | `GET /api/focus` (Villen, offene Aufgaben, Grund, Verlauf) |
| Fokus setzen | `POST /api/focus` mit `{"villaIds":[34,3],"reason":"..."}` |
| Fokus aufheben | `DELETE /api/focus` |

Antwort beim Setzen enthält je Villa `status`, `open` und `done`, dazu
`ready_to_release`. Setzen und Aufheben landen in `project_focus_history`
(Villa-IDs, Grund, Zeitpunkt, Aktion) und sind damit später belegbar.

## Verhalten im Chat-Master

Legt der Master-Agent während eines Fokus eine neue Villa an, bleibt sie
bestehen, wird aber nicht gestartet. Die Antwort nennt den Grund: die
priorisierten Projekte laufen zuerst. Das ist bewusst keine stille Ablehnung.

## Grenzen

- Der Fokus kennt keine Fristen und keine Reihenfolge zwischen den Fokus-Villen;
  der Scheduler arbeitet sie nach Fortschritt ab.
- Ein Fokus auf eine unbekannte Villa wird abgelehnt, statt still zu wirken.
- Villen, die es nicht mehr gibt, gelten als erledigt und halten den Fokus nicht
  fest.
