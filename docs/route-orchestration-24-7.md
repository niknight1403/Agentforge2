# 24/7-Betrieb ohne Limit-Abriss

Wie Agentforge2 dauerhaft weiterentwickelt, ohne an ein Modell-Limit zu stoßen:
Kontingente werden mitgezählt, Routen werden rechtzeitig gewechselt, und der
Grundlast-Träger ist eigene Hardware statt eines Fremdkontingents.

## Was gebaut ist

`server/route-quota.mjs` ist die Buchhaltung, die Hunter und Cascade bisher
fehlte:

- **Rollierende Fenster** pro Route: Anfragen und Token über 60 Sekunden und
  über 24 Stunden. Bewusst rollierend, nicht nach Kalendertag, weil Anbieter
  ihre Tageslimits zu unterschiedlichen Zeiten zurücksetzen.
- **Buchung vor dem Aufruf**: `consume()` lehnt ab, bevor ein Aufruf rausgeht,
  und nennt den Grund (`rpm`, `rpd`, `tpm`, `tpd`, `cooldown`).
- **Pausen je Fehlerklasse**: 429 mit `Retry-After`, Quota, Auth, 5xx, Netz.
  Drei Fehler in Folge verdoppeln die Pause bis 30 Minuten (Sicherung).
- **Auswahl mit Reihenfolge**: eigene Hardware zuerst, dann freie Routen nach
  Restkontingent mal Trefferquote. Werkzeuganforderung filtert Routen ohne
  Tool-Calling aus.
- **Kapazitätsplan**: `plan()` sagt vorher, ob die vorhandenen Routen eine
  geforderte Last tragen, und nennt den Fehlbetrag in Aufträgen.
- **Zustand überlebt Neustarts** (`saveState` / `createLedger({ file })`,
  atomares Schreiben).

CLI:

```bash
node scripts/ops/route-quota.mjs status
node scripts/ops/route-quota.mjs next --tokens 3000 --tools
node scripts/ops/route-quota.mjs plan --per-hour 40 --hours 24
```

Konfiguration: `config/routes.json`. `limitsVerified: false` heißt „Zahl aus der
Anbieter-Doku, im Dashboard bestätigen". Der Ledger zählt lokal mit; er ersetzt
keine Anbieter-Anzeige.

## Die Rechnung, die zählt

Ein kostenloser Tarif liegt typisch bei 1.000 bis 1.500 Aufträgen pro Tag.
Ein autonomer Entwicklungsagent braucht pro Aufgabe 20 bis 60 Modellaufrufe
(Architekt, Implementierer, Prüfer, Reparaturen). Damit trägt ein einzelner
kostenloser Tarif etwa 20 bis 70 Aufgaben pro Tag. Drei Tarife parallel
verschieben das auf 60 bis 200 Aufgaben — bis einer der Anbieter die Grenze
ändert.

Eigene Hardware hat diese Grenze nicht. Ollama auf der Oracle-VM
(`ollama-free-a1`, 4 OCPU, 24 GB) mit `qwen2.5-coder:7b` liefert Dauerbetrieb
ohne Fremdkontingent; die Geschwindigkeit entscheidet über den Durchsatz, nicht
ein Tageslimit. Deshalb steht die lokale Route in `config/routes.json` auf
`isLocal: true` und wird immer zuerst gewählt.

**24/7 ohne Limit-Abriss heißt also: eigene Hardware als Grundlast, freie
Tarife als Burst.** Nicht: mehr kostenlose Konten.

## Was nicht gebaut wird

Automatisches Anlegen von Anbieter-Konten, um Gratis-Kontingente zu
vervielfachen, ist in den Nutzungsbedingungen der Anbieter untersagt
(Multi-Accounting, Umgehung von Ratenlimits). Es führt zu Sperren genau der
Konten, auf denen der Betrieb dann steht — das Gegenteil von 24/7. Für dieses
Ziel baue ich das nicht: keine automatische Registrierung, keine erfundenen
Identitäten, kein Weiterverkauf von Schlüsseln.

Ein Agent, der Zugang zu einem Konto hat, darf daraus aber selbstverständlich
Routen auswählen, prüfen und rotieren. Genau das macht der Ledger: er entscheidet
pro Auftrag, welche hinterlegte Route dran ist, und wechselt selbstständig,
bevor ein Limit reißt.

## Verdrahtung im Aufrufpfad (Stufe 1)

`server/route-selection.mjs` übersetzt eine Route aus der Tabelle `routes` in
ein Ledger-Konto und lässt sie vor dem Aufruf zu. `server/llm.mjs` fragt die
Zulassung in `callOpenAiCompatible()` direkt vor dem Circuit Breaker und verbucht
das Ergebnis danach. Zwei Schalter steuern das Verhalten:

| Variable | Standard | Wirkung |
| --- | --- | --- |
| `VF_ROUTE_LEDGER` | `0` | `1` aktiviert die Zulassung; ohne sie läuft alles wie vorher |
| `LLM_LOCAL_ONLY` | `1` | `1` lässt ausschließlich lokale Endpunkte zu, `0` erlaubt freie Tarife als Burst |
| `VF_ROUTE_LEDGER_STATE` | leer | Pfad für den Zustand (Kontingente, Pausen); leer = nur im Speicher |

Konto = `key_env`, sonst der Anbieter. Zwei Routen mit demselben Schlüssel
teilen damit ein Kontingent, und ein 429 auf einer von beiden sperrt beide,
weil die Sperre am Konto hängt (`accountCooldowns`) und auch für Routen greift,
die der Prozess erst später kennenlernt.

Ablauf einer Anfrage mit aktivem Ledger:

1. `admit(route, {tokens})` prüft Konto-Sperre, Minuten- und Tagesfenster.
   Verweigerung wirft `RATE_WINDOW_BUSY` mit `reason` und `retryAfterMs`; die
   Kaskade nimmt die nächste Route, statt in einen 429 zu laufen.
2. Aufruf über Circuit Breaker und Anbieterfenster (unverändert).
3. `settle()` verbucht Erfolg oder Fehler; 429, Quota und Auth sperren das Konto
   für die errechnete Pause.

`routingStatus()` zeigt je Route zusätzlich `quota` (Konto, Tagesverbrauch,
Kopffreiheit, Sperre). Zum Prüfen auf der VM:

```bash
VF_ROUTE_LEDGER=1 LLM_LOCAL_ONLY=0 node -e "import('./server/llm.mjs').then(m=>console.log(JSON.stringify(m.routingStatus().routes.slice(0,3),null,1)))"
```

Achtung: `LLM_LOCAL_ONLY=1` (Standard) lässt keine Cloud-Route zu. Wer den
Betrieb ausschließlich lokal fährt, lässt es so; wer freie Tarife als Burst
nutzt, setzt es bewusst auf `0`.

## Neuen Anbieter aufnehmen

1. Account selbst anlegen, Schlüssel in die Umgebung (`*_API_KEY`).
2. Eintrag in `config/routes.json`: `id`, `baseUrl`, `model`, `apiKeyEnv`,
   `limits` aus dem Dashboard.
3. `node scripts/ops/route-quota.mjs plan --per-hour <Ziel>` prüfen.
4. `node scripts/ops/route-quota.mjs status` nach dem ersten Tag: `headroom`
   zeigt, wie viel Luft noch ist.

## Tests

```bash
node --test server/tests/route-quota.test.mjs
```

13 Fälle ohne Netzwerk: Minuten- und Tagesfenster, Token-Budget, 429-Pause,
Sicherung mit Verdopplung, Werkzeugfilter, Lückenmeldung, Plan-Arithmetik,
Persistenz über Neustart.

## Offen

- Anbindung an `server/llm-cascade.mjs`: der Cascade kann den Ledger fragen,
  statt nur nach Priorität zu sortieren. Der Ledger ist dafür vorbereitet
  (`next()`, `consume()`, `settle()`), die Verdrahtung in den Aufrufpfad ist der
  nächste Schritt — sie berührt den produktiven Modellpfad und braucht einen
  eigenen Durchlauf mit vollständiger Suite.
- Kennzahlen für die Villa-Übergabe: `route_switch_rate`, `quota_refusals`,
  `covered_ratio` aus `status()` und `plan()`.
