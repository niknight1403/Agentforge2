# TASTE- und SPION-Artefakte als Pflicht der Villa-Übergabe

Stand: 02.11.2026

## Warum

Der DeepAgent-Prompt sieht zwei Agenten vor, die vor dem Bauen das Umfeld klären:
**TASTE** erstellt ein Präferenzprofil des Nutzers, **SPION** beobachtet den
Wettbewerb. Beide waren beschrieben, aber ihre Ergebnisse wurden bei der
Villa-Übergabe nicht verlangt. Dadurch konnte eine Villa entstehen, die das
Produkt erbt, aber nicht weiß, *warum* jemand es will und *was* andere schon tun.

Seit diesem Stand prüft `POST /api/deep/projects/:id/develop` beide Artefakte,
bevor eine Villa angelegt wird.

## Ablage

Beide Dateien liegen im Projektordner des Deep-Projekts (`DEEP_DIR/<projekt-id>`):

- `taste.json` — Präferenzprofil
- `spion.json` — Wettbewerbsbeobachtung

Nur JSON zählt. Freitext oder Markdown lässt sich nicht maschinell prüfen und
gilt als fehlender Beleg.

## `taste.json`

```json
{
  "statements": [
    {
      "claim": "Niko will reine Entwicklungsarbeit ohne Marketingpflicht",
      "evidence": { "source": "repo:cybersarah/commits" }
    }
  ]
}
```

Regeln:

- mindestens **3** Aussagen
- jede Aussage mindestens **15 Zeichen** Inhalt
- jede Aussage braucht eine Quelle in `evidence.source`
- die Quelle ist entweder eine öffentliche `http(s)`-Adresse oder eine
  ausdrückliche Belegart mit Ursprung: `repo:`, `produkt:`, `preis:`,
  `feedback:`, `kunde:`, `interview:`, `kauf:`
- eine Aussage ohne Quelle blockiert die Übergabe und wird mit ihrem Index genannt

## `spion.json`

```json
{
  "competitors": [
    {
      "name": "Anbieter A",
      "observation": "Baut Web-Apps direkt im Browser ohne lokale Installation.",
      "source": "https://a.example",
      "date": "2026-10-20"
    }
  ]
}
```

Regeln:

- mindestens **2** Wettbewerber
- `name` gesetzt, `observation` mindestens **20 Zeichen**
- `source` ist eine öffentliche `http(s)`-Adresse; `localhost`, `127.0.0.1`,
  `10.x`, `192.168.x` und `::1` sind keine Wettbewerbsquelle
- `date` im Format `JJJJ-MM-TT` und nicht in der Zukunft

## Was das Gate nicht tut

- Es ersetzt keine Recherche: es prüft nur, ob Aussagen belegt sind.
- Es bewertet keine Meinung und keine Strategie.
- Es liest keine fremden Konten, umgeht keine Logins und ruft keine Seiten ab.
  `source` ist ein Nachweis, kein Abrufauftrag.
- Es erfindet nichts: fehlt eine Angabe, blockiert die Übergabe mit dem
  konkreten Grund statt mit einem geschätzten Erfolg.

## Antwort bei fehlenden Artefakten

```
HTTP 409
{
  "ok": false,
  "gateBlocked": true,
  "artifactBlocked": true,
  "blockers": [{ "key": "taste", "label": "...", "detail": "..." }],
  "message": "Uebergabe-Artefakte fehlen: ..."
}
```

Das Produkt-Gate bleibt vorgelagert: fehlt schon das belegte Produkt, meldet der
Endpunkt nur die Produkt-Blocker (`artifactBlocked` fehlt dann).

## Villa-Diagnose

`assessVillaConfiguration` prüft zusätzlich `taste_profile` und
`spion_observation`:

- mit übergebenen Artefakten: `pass` oder `blocked` nach obigen Regeln
- ohne Artefaktangabe: `warning` mit dem Hinweis, dass kein Profil übergeben
  wurde. Bestehende Villen werden dadurch nicht fälschlich rot, der Mangel
  bleibt aber sichtbar.
- Secrets in den Artefakten erzeugen einen zusätzlichen `blocked`-Eintrag
  `artifact_secrets`
