# Darstellerinnen: Persoenlichkeiten, Kleidungs-Packs, Regie-Chat (09.11.2026)

## Warum

Die Villa konnte bisher produzieren, aber niemand konnte sagen, WER dort spielt
und WIE sie aussieht. Fuer eine Medien-/Companion-Villa fehlten drei Dinge:
eine besetzbare Figur, wechselbare Garderobe und ein Weg, ihr Anweisungen zu
geben, ohne im Code zu editieren.

## Persoenlichkeiten (`server/persona-packs.mjs`)

Figur = Name, Tagline, Stimme, Sprachen, mindestens drei Charakter-Merkmale,
Grenzen. Eine Figur ist erst `castable`, wenn zusaetzlich mindestens ein
Kleidungs-Pack existiert; sonst nennt `gaps` genau die Luecken
(`charakter_zu_duenn`, `stimme_fehlt`, `grenzen_fehlen`, `kleidungs_pack_fehlt`).

Grundsatz: eigenstaendige Kunstfiguren. Keine Nachahmung realer Personen, keine
geschuetzten Marken-Outfits. Die Grenzen sind Teil der Figur, nicht Deko.

## Kleidungs-Packs

Ein Pack hat Anlass (`alltag`, `business`, `abend`, `sport`, `studio`, `reise`)
und Teile je Slot (`top`, `bottom`, `dress`, `outerwear`, `shoes`, `hair`,
`makeup`, `accessory`) mit Beschreibung, Farben und Material. Ein Look ohne
Oberteil (Top oder Kleid) oder ohne Schuhe wird abgelehnt — sonst entstehen
unvollstaendige Figurenbilder.

`resolveLook(personaId, {occasion, day})` waehlt deterministisch (Seed aus Figur,
Pack, Anlass, Tag): derselbe Auftrag am selben Tag ergibt dieselbe Garderobe.
Fehlt ein Pack fuer den Anlass, wird das im Ergebnis benannt
(`kein_pack_fuer_anlass_genommen_standard`), nichts wird erfunden.

## Regie-Chat (`server/director-chat.mjs`)

Anweisungen werden als typisierte Vorgaben gespeichert: `outfit`, `scene`,
`tone`, `schedule`, `pause`, `resume`, `persona`, `prop`, `no_go`. Die Erkennung
ist deterministisch (Stichwort + Vorrang: negative Anweisungen vor positiven,
Szenenbegriffe vor Zeitangaben) und braucht kein Modell.

Ehrlichkeitsregel: Speichern ist nicht umsetzen. Eine Anweisung steht auf
`offen`, bis ein Produktionslauf sie mit `consumeDirections(villaId, personaId,
kinds)` abholt; erst dann ist sie `angewandt`. Der Chat behauptet nie, ein Bild
oder Video sei fertig.

## Kostenlose Medienwerkzeuge (`server/free-media-tools.mjs`)

Inventur per Binary-Test (ffmpeg, ffprobe, ImageMagick, sox) mit Version und
Grund bei Nichtverfuegbarkeit. Operationen: Bild skalieren, Bilder zu Video
montieren, Standbild ziehen, Titel einbrennen. Jede Operation laeuft nur in
`VF_MEDIA_DIR` (Default `server/data/media`), mit Timeout, und das Ergebnis wird
geprueft (Datei da, Groesse, ffprobe). Was fehlt, wird als Luecke gemeldet.

## Fertigstellungs-Bericht (`server/deep-completion.mjs`)

`GET /api/deep/projects/:id/completion` beantwortet "ist die Villa-Entwicklung
und die Live-Ansicht fertig?" mit Belegen statt Vermutung: Produkt-Gate,
TASTE/SPION-Artefakte, verknuepfte Villa, Einstiegspunkt der Live-Ansicht
(`index.html`/`web-dist/index.html`). Blocker werden nach Bereich
(`produkt`, `uebergabe`, `villa`, `live`) gruppiert und mit naechster Aktion
ausgegeben.

## API

```
GET  /api/villas/:id/cast                       Cast-Uebersicht
POST /api/villas/:id/cast                       Figur anlegen
GET  /api/personas/:id                          Figur + Packs + Luecken
PATCH/api/personas/:id                          Figur aendern
GET  /api/personas/:id/card                     Karte fuer Bild-/Video-Laeufe
GET  /api/personas/:id/packs                    Packs
POST /api/personas/:id/packs                    Pack anlegen
GET  /api/personas/:id/look?occasion=&day=      Garderobe (deterministisch)
GET  /api/villas/:id/director                   Verlauf, offen, angewandt
POST /api/villas/:id/director                   Anweisung geben
POST /api/villas/:id/director/consume           Anweisungen als uebernommen markieren
GET  /api/media-tools                           Inventur + Faehigkeiten
POST /api/media-tools/resize|images-to-video|thumbnail|burn-title
GET  /api/deep/projects/:id/completion          Fertigstellungs-Bericht
GET  /api/free-routes/hunter                    Routen-Jaeger + Medienwerkzeuge
POST /api/free-routes/hunter/tick               Jagd ausloesen (Admin)
```

Schreibende Endpunkte sind wie im Hub ueblich Admins vorbehalten (`openMode`
bleibt unberuehrt).

## Tests

`server/tests/persona-packs.test.mjs` (9), `server/tests/director-chat.test.mjs` (8),
`server/tests/deep-completion.test.mjs` (5). Gesamtsuite: 596 gruen.
