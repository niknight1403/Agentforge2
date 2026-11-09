# Architektur: 24/7-Betrieb ohne Ratenlimit-Abriss

Analyse des heutigen Codes und Entwurf für einen Betrieb, der dauerhaft
weiterentwickelt, ohne an ein Limit zu stoßen. Zuerst der Befund am echten
Code, dann die Zielarchitektur mit Änderungspunkten pro Datei.

Der Satz „ohne Ratenlimits" ist technisch nur für eigene Hardware wahr. Für
Fremdanbieter heißt das erreichbare Ziel: **kein Stillstand**. Jeder Auftrag
wird entweder bedient oder mit Grund und Wiederaufnahmezeit geparkt. Nie ein
schweigender Stillstand, nie ein Limit-Abriss im Lauf.

---

## 1. Befund: was heute trägt und wo es reißt

### Vorhandene Bausteine

| Baustein | Datei | Aufgabe |
| --- | --- | --- |
| Einstieg | `server/llm.mjs:294` `chat()` | Budgetprüfung, Kaskade, Verbrauch buchen |
| Routenwahl | `server/llm.mjs:32` `pickRoute()` | Prioritätsreihenfolge |
| Cooldowns | `server/llm.mjs:63-67` | 401/403 5 min, 429 2–10 min, sonst 15 s |
| Ratenbegrenzung | `server/request-limiter.mjs:2` | gleitendes Fenster, ein interaktiver Vorbehalt |
| RPM-Tabelle | `server/llm.mjs:129` `routeRpm()` | Gemini 8, Groq 20, Cerebras 10, sonst 30 |
| Sicherung | `server/circuit-breaker.mjs:2` | 3 Fehler je Host, 30 s offen, ein Halb-Offen-Test |
| Kaskade | `server/llm-cascade.mjs:10,18` | Reihenfolge und Folgeversuche |
| Discovery | `server/free-route-hunter.mjs:75-213`, `free-route-cycle.mjs:59` | lokale und keyfreie Quellen, OpenRouter-`:free` |
| Key-Verwaltung | `server/keyforge.mjs:176,240` | eingehende Schlüssel prüfen, Routen anlegen |
| Ledger | `server/route-quota.mjs` (neu) | Kontingente je Konto, Plan, Rotation |
| Konfiguration | `config/resilience_config.yaml`, `config/routes.json` | Anbieter, Pausen, Limits |

### Acht Bruchstellen, jede mit Beleg

1. **Limits hängen am Namen, nicht an Daten.** `routeRpm()` erkennt Anbieter per
   Teilstring im Routennamen (`llm.mjs:129-137`). Jeder neue Anbieter fällt auf
   `VF_RPM_DEFAULT=30`. Kein Tageslimit, keine Tokenzählung, keine
   Unterscheidung nach Modell.
2. **Die Wahl kennt kein Restkontingent.** `pickRoute()` sortiert nach
   Priorität. Eine Route wird also so lange geschlagen, bis sie 429 liefert,
   statt die Last vorher zu verteilen.
3. **Pausen liegen an der Route, nicht am Konto.** `UPDATE routes SET
   cooldown_until` (`llm.mjs:67`) trifft eine Zeile. Zwei Routen mit demselben
   Schlüssel umgehen die Pause abwechselnd, bis das Konto dicht ist.
4. **Warten blockiert den Lauf.** Fehlschläge enden als Exception in der
   Kaskade. Der Auftrag hat keinen Zustand, der einen Neustart überlebt; ein
   Limit-Sturm kostet den Fortschritt.
5. **Kein Warteschlangen-Eigentum.** Wer arbeitet, entscheidet der Scheduler mit
   Zeitscheiben (`server/agents.mjs:1367`), nicht die verfügbare Kapazität.
   Ergebnis: Sturm auf eine Route statt Taktung.
6. **Degradation ist binär.** `llm.mjs:301` kennt „Budget erschöpft, aber freie
   Route vorhanden" und „alles dicht". Dazwischen fehlt die Leiter: kleineres
   Modell, weniger Schritte, gespeichertes Ergebnis.
7. **Lokale Kapazität ist ein Engpass ohne Messung.** `ollamaQueueStats()`
   (`llm.mjs:123`) zählt Wartende, aber niemand regelt die Zufuhr danach.
   Durchsatz der VM (4 OCPU, 24 GB) ist die eigentliche Obergrenze des Systems.
8. **Keine Kennzahlen für den Betrieb.** Es gibt `routingStatus()` und
   `hunterStatus()`, aber nicht `covered_ratio`, `quota_refusals`,
   `park_time`, `switch_rate`. Ohne die ist „24/7" nicht belegbar.

Dazu die Regel, die schon gilt und bleibt: keine automatische Anlage von
Anbieterkonten (`docs/route-orchestration-24-7.md`). Kapazität entsteht durch
eigene Hardware, nicht durch zusätzliche Konten.

---

## 2. Zielarchitektur

```
                         ┌──────────────────────────────┐
   Idee / Aufgabe ──────▶│ 1 Auftragseingang (dauerhaft) │  jobs-Tabelle
                         │   pending → leased → running  │  Lease + Checkpoint
                         └──────────────┬───────────────┘
                                        │  Zulassung nur mit Kontingent
                         ┌──────────────▼───────────────┐
                         │ 2 Zuteilung (Taktgeber)      │  fair, alternd,
                         │   Budget je Fenster          │  kein Verhungern
                         └──────────────┬───────────────┘
              ┌─────────────────────────┼──────────────────────────┐
              │                         │                          │
    ┌─────────▼─────────┐   ┌───────────▼──────────┐   ┌───────────▼─────────┐
    │ 3 Routen-Register │   │ 4 Zulassung/Ledger   │   │ 6 Degradationsleiter│
    │  Konto, Limit,    │◀─▶│  consume/settle,     │──▶│  LOKAL → BURST →    │
    │  Fähigkeiten      │   │  Konto-Sperre, Plan  │   │  REDUZIERT → PAUSE  │
    └─────────┬─────────┘   └───────────┬──────────┘   └─────────────────────┘
              │                         │
    ┌─────────▼─────────────────────────▼──────────────────────────────────┐
    │ 5 Ausführung: Arbeiter-Pool je Route (eigene Parallelität),          │
    │   lokale Ollama-Bahn zuerst, freie Tarife als Burst                  │
    └─────────┬────────────────────────────────────────────────────────────┘
              │  Erfolg / 429 / Retry-After / Checkpoint
    ┌─────────▼────────────────────────────────────────────────────────────┐
    │ 7 Betrieb: Kennzahlen, Alarm, Kill-Switch-Stufen, Admin-Overrides    │
    └──────────────────────────────────────────────────────────────────────┘
```

### Schicht 1 — Auftragseingang (dauerhaft)

Neue Tabelle `jobs`: `id, villa_id, kind, payload, state, lease_until,
attempts, next_attempt_at, checkpoint, last_error, created_at, updated_at`.
Lebenszyklus `pending → leased → running → (done | parked | failed)`.
Ein Lauf ist eine Lease mit Ablaufzeit; stirbt der Prozess, wird die Lease
frei und der nächste Arbeiter setzt am `checkpoint` fort.

Warum: Nur so überlebt Fortschritt einen 429-Sturm, einen Neustart oder einen
Deploy. Heute ist der Zustand im Speicher des laufenden Aufrufs.

### Schicht 2 — Zuteilung nach Kapazität

Der Taktgeber gibt eine Lease nur heraus, wenn Schicht 4 sie zulässt
(`consume()` vor dem Aufruf, nicht danach). Fairness über Alterung: je länger
ein Auftrag wartet, desto höher sein Gewicht, damit ein großer Auftrag die
kleinen nicht aushungert.

Formel für die Zufuhr:

```
zufuhr_pro_minute ≤ Σ_routen (rpm_route − verbraucht_minute) + lokale_bahn
zufuhr_pro_tag    ≤ Σ_konten (rpd_konto − verbraucht_tag) + lokale_bahn
```

Die zweite Summe läuft **je Konto**, nicht je Route. Genau das rechnet
`server/route-quota.mjs` seit `34c5cb5`, inklusive Sperre aller Routen eines
Kontos bei 429.

### Schicht 3 — Routen-Register

Eine Quelle: `config/routes.json` (Kontingente, `isLocal`, `tools`) plus
DB-Spalten für Messwerte. Jede Route trägt: Konto, Fähigkeiten (Tool-Calling,
Kontextfenster), Kosten (0 oder Preis), bestätigte Limits
(`limitsVerified`). Discovery (`free-route-hunter.mjs`) schreibt nur noch ins
Register und markiert neue Routen als `unverified`, bis eine Probe Fähigkeiten
bestätigt. Damit verschwinden Fehlversuche auf Routen ohne Tool-Calling.

### Schicht 4 — Zulassung und Kontingent

`server/route-quota.mjs` wird in `llm.mjs` verdrahtet, an zwei Stellen:

```js
// vor dem Versuch, ersetzt pickRoute() als Entscheider
const pick = ledger.next({ tokens: estimateTokens(messages), needsTools: !!opts.tools });
if (!pick.route) return parkJob(jobId, { reason: 'kein_kontingent', retryAt: earliestRetry(pick.gaps) });

const ticket = ledger.consume(pick.route.id, { tokens: estimateTokens(messages) });
try {
  const out = await callRoute(pick.route, messages, opts);
  ledger.settle(pick.route.id, { ok: true, tokens: out.tokens });
  return out;
} catch (error) {
  const pause = ledger.settle(pick.route.id, {
    ok: false, status: error.status, retryAfterMs: error.retryAfterMs
  });
  return retryOrPark(jobId, { pause, error });
}
```

`pickRoute()` bleibt als reine Prioritätsordnung erhalten (Rückfallebene und
Tests), entscheidet aber nicht mehr allein.

### Schicht 5 — Ausführung

- Eigene Bahn für Ollama mit fester Parallelität (`OLLAMA_MAX_PARALLEL`) und
  Warteschlange; Zufuhr wird gedrosselt, bevor die Warteschlange voll ist
  (Ziel: Wartezeit p95 unter einem Schritt-Zeitbudget).
- Je Fremdroute ein Arbeiter-Slot, Parallelität = `min(rpm/6, 4)`, damit ein
  Burst nicht selbst den 429 erzeugt.
- Zeitbudget je Schritt; Überschreitung beendet den Versuch und gibt die Lease
  zurück, statt den Slot zu blockieren.

### Schicht 6 — Degradationsleiter

Vier Stufen, jede mit klarer Bedingung und Rückweg:

| Stufe | Bedingung | Verhalten |
| --- | --- | --- |
| LOKAL | lokale Route nutzbar | alles lokal, freie Tarife nur für Qualitätsschritte |
| BURST | lokale Bahn gesättigt | freie Tarife bis zu ihrer Grenze, lokale Bahn weiter als Grundlast |
| REDUZIERT | kein Kontingent, lokale Bahn überlastet | kleineres Modell, kürzere Kontexte, weniger Prüfschritte, gespeicherte Ergebnisse wiederverwenden |
| PAUSE | gar keine Route | Auftrag parken mit `next_attempt_at`, Alarm, kein Verlust |

Der Unterschied zu heute: Stufe REDUZIERT existiert überhaupt nicht, und PAUSE
verliert keinen Fortschritt.

### Schicht 7 — Betrieb

Kennzahlen, die „24/7" belegbar machen:

- `covered_ratio` = bediente Aufträge / geforderte Aufträge je Tag
- `quota_refusals` je Route und Grund (`rpm|rpd|tpm|tpd|cooldown`)
- `park_time_p95` = Wartezeit geparkter Aufträge
- `switch_rate` = Routenwechsel je 100 Aufrufe
- `local_share` = Anteil lokal bedienter Aufrufe (Ziel: steigend)
- `starvation_max` = längste Wartezeit eines Auftrags

Kill-Switch in Stufen (`normal`, `kein_burst`, `nur_lokal`, `halt`) statt eines
Binärschalters. Alarm, wenn `covered_ratio < 0.95` über 6 Stunden oder
`park_time_p95 > 30 min`.

---

## 3. Kapazitätsrechnung für diesen Aufbau

Ein Agentenauftrag braucht 20 bis 60 Modellaufrufe (Planen, Bauen, Prüfen,
Reparieren). Kosten pro Aufruf: 1.500 bis 6.000 Token.

| Träger | Grenze | Aufträge pro Tag |
| --- | --- | --- |
| Ollama auf Oracle-VM, 4 OCPU/24 GB, 7B-Modell | Durchsatz, kein Tageslimit | 200 bis 600 (abhängig von Tokens/s und Schrittlänge) |
| Gemini free | ~1.500 Anfragen/Tag | 25 bis 75 |
| Groq free | ~1.000 Anfragen/Tag | 15 bis 50 |
| OpenRouter free | ~50 Anfragen/Tag | 1 bis 2 |

Ohne eigene Hardware tragen die drei freien Tarife zusammen rund 40 bis 130
Aufträge pro Tag. Mit der VM liegt die Grenze beim Durchsatz, nicht beim
Kontingent. Deshalb ist die VM Grundlast und die freien Tarife sind Burst, und
deshalb steht die lokale Route in `config/routes.json` auf Platz eins.

Ein 24/7-Betrieb mit mehreren Villen parallel braucht entweder mehr lokale
Kerne oder eine Priorisierung der Villen. Beides ist eine Kapazitätsfrage, keine
Limit-Frage. `plan({demandPerHour, horizonHours})` beantwortet sie vorab in
Aufträgen und nennt den Fehlbetrag.

---

## 4. Umsetzung in Stufen

Jede Stufe ist einzeln lieferbar und einzeln prüfbar.

**Stufe 1 — Ledger verdrahten (kleinster Hebel).**
`llm.mjs`: `pickRoute()` durch `ledger.next()` ergänzen, `consume()`/`settle()`
um den Aufruf legen, `routeRpm()` durch `routes.json` ersetzen.
Abnahme: Test „429 auf Konto A sperrt alle Routen von A", `routingStatus()`
zeigt `headroom` je Route, Suite grün.

**Stufe 2 — Pausen am Konto persistieren.**
Cooldown-Spalte je Konto (`accounts`-Tabelle) statt je Route; `llm.mjs:67`
schreibt dort. Abnahme: zwei Routen, ein Konto, ein 429 → beide gesperrt, nach
Ablauf beide wieder frei.

**Stufe 3 — Auftragstabelle und Lease.**
`jobs`-Tabelle mit Lease und Checkpoint; Scheduler erzeugt Leases nur bei
Zulassung. Abnahme: Prozess mitten im Auftrag beenden, Neustart setzt fort,
kein doppelter Schritt (`attempts` und `checkpoint` belegen es).

**Stufe 4 — Degradationsleiter.**
Vier Stufen in `llm.mjs` mit Kennzahl `degradation_level`; REDUZIERT schaltet
Modellgröße und Schrittzahl. Abnahme: Kontingent künstlich auf null setzen,
System läuft auf REDUZIERT weiter, `park_time_p95` bleibt unter 30 min.

**Stufe 5 — Kennzahlen und Alarm.**
`/api/stats` um die sechs Kennzahlen erweitern, Schwellwert-Alarm an den
bestehenden Wächter. Abnahme: 24-Stunden-Lauf mit `covered_ratio ≥ 0.95`.

Reihenfolge ist bewusst so: Stufe 1 und 2 wirken sofort und sind risikoarm,
Stufe 3 berührt den Auftragspfad und braucht die vollständige Suite.

---

## 5. Risiken und ehrliche Grenzen

- **Verdrahtung berührt den Live-Pfad.** `chat()` ist der produktive
  Modelleingang. Änderungen dort brauchen die vollständige Suite plus einen
  Lauf gegen die VM, nicht nur Unit-Tests.
- **Fremdlimits ändern sich ohne Vorwarnung.** `limitsVerified` ist deshalb ein
  Datum, kein Häkchen: nach sieben Tagen gilt ein Wert als unbestätigt und der
  Plan warnt.
- **Ein Modell auf einer VM ist kein Cluster.** Bei mehreren Villen parallel
  entscheidet die Priorisierung, nicht die Rotation. Mehr Kerne sind die
  ehrliche Antwort.
- **Kleine Modelle scheitern an Werkzeugketten.** Für Schritte mit
  Dateiänderungen bleibt eine Route mit sicherem Tool-Calling nötig; ohne sie
  führt der Agent keine Änderungen aus, sondern plant nur.
- **„Ohne Ratenlimits" gilt nur lokal.** Für Fremdanbieter garantiert diese
  Architektur Fortschritt oder ein begründetes Parken, keine unbegrenzte
  Durchsatzrate. Wer mehr will, braucht mehr eigene Hardware.

---

## 6. Verhältnis zu bestehenden Dokumenten

- `docs/route-orchestration-24-7.md` — Ledger, Rotation, Kapazitätsplan (gebaut)
- `config/routes.json` — Register mit Kontingenten (gebaut)
- `config/resilience_config.yaml` — Anbieter, Pausen (bestehend)
- `ORACLE-24-7-STATUS.md` — Betriebsstand der VM (bestehend)

Dieses Dokument beschreibt das Zielbild und die Reihenfolge, in der die
bestehenden Teile zusammengeführt werden.
