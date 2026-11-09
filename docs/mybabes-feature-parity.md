# mybabes.ai: Funktionsinventar und Abgleich mit unserem Produkt

Quelle der Beobachtung: oeffentliche Startseite `https://mybabes.ai`, abgerufen am
2026-11-09 (kein Login, keine Umgehung von Schutzmechanismen). Nur Funktionen, die
auf der Seite benannt oder verlinkt sind, stehen in dieser Liste. Nichts davon ist
aus Marketingtexten abgeleitet, was nicht dort stand.

Rechtlicher Hinweis: Wir uebernehmen keine Inhalte, Bilder, Texte, Marken oder
Datenmodelle von mybabes.ai. Uebernommen wird ausschliesslich die Funktionsidee
("Explore, Chat, Generator, Story, Creator"), umgesetzt mit eigenen Dateien und
eigenen Namen. Das entspricht der Regel im DeepAgent-Prompt: keine 1:1-Uebernahme.

## Beobachtete Funktionen

| # | Funktion (Seite) | Beleg auf der Startseite | Status in unserem Produkt |
|---|---|---|---|
| 1 | Explore-Marktplatz fuer Charaktere mit Tag-Filtern (Stil realistisch/anime, Kategorien) | Links `/explore/babes`, `/explore/tag/style/realistic`, `/explore/tag/...` | offen (F1) |
| 2 | Explore fuer generierte Bilder und Videos | Links `/explore/images`, `/explore/videos` | offen (F1) |
| 3 | Stories als eigene Inhaltsgattung | Link `/explore/stories` | offen (F7) |
| 4 | Reels (kurze Videoformate) | Link `/reels` | offen (F6) |
| 5 | Chat mit Charakteren, persistentes Gedaechtnis | "Characters can hold long-running stories, remember details that matter" | offen (F3) |
| 6 | Chat-Galerie (Medien im Verlauf) | Link `/gallery` | offen (F3) |
| 7 | Stimme (Sprachausgabe und Spracheingabe) | "chat, voice, image generation, video generation" | offen (F4) |
| 8 | Custom-Babe-Builder: Aussehen, Backstory, Persoenlichkeit, Sprechstil | FAQ "The Custom Babe builder lets you define appearance, backstory, personality, and speaking style" | offen (F2) |
| 9 | Template-Babe (Vorlage als Startpunkt) | Link `/babes/create`, "Create Template Babe" | offen (F2) |
| 10 | Visual Identity Anchor: stabile visuelle Merkmale ueber Bilder/Videos | FAQ "the consistency layer that keeps a character's visual traits stable" | offen (F2) |
| 11 | Bildgenerator in 2K | FAQ "generate 2K images", Link `/image-generator` | offen (F5) |
| 12 | Videogenerator mit Modellwahl (WAN, Seedance) | Links `/video-generator`, "Seedance 2.0/2.5, WAN 2.7/3.0" | offen (F6) |
| 13 | Story-Creator fuer fortlaufende Handlungen | Link `/tools/story-creator` | offen (F7) |
| 14 | Creator-Bereich: eigene Charaktere/Inhalte veroeffentlichen, Remix | Link `/become-creator` | offen (F8) |
| 15 | Token- und Abo-Modell, kostenloser Einstieg | FAQ "Premium visual features use a flexible token or subscription system" | offen (F8) |
| 16 | Konten, Alterssperre, Rechtsseiten | Links `/docs/terms`, `/docs/privacy`, `/docs/verification` | offen (F8) |

## Grenzen, die kein Agent erfinden darf

- Bild- und Videogenerierung brauchen einen echten Anbieter mit Schluessel
  (`FAL_KEY` oder vergleichbar). Fehlt der Schluessel, zeigt die Oberflaeche
  "nicht konfiguriert" und erzeugt kein Fake-Ergebnis.
- Zahlungen brauchen einen freigeschalteten Zahlungsanbieter. Ein Token-Zaehler
  ist ohne Anbieter nur eine Anzeige, kein Verkauf.
- Die Chat-Antworten laufen weiter ueber die lokale Regel-Engine des Produkts,
  solange kein Modell-Endpunkt konfiguriert ist. Das Produkt sagt das offen.
- Alterssperre bleibt Pflicht: das Produkt startet mit Altersabfrage, weil die
  Vorlage ausschliesslich fuer Erwachsene gedacht ist.

## Abnahmeregel fuer diese Runde

Die acht Auftraege F1 bis F8 werden als Aufgaben in der Deep Villa angelegt. Ein
Auftrag gilt in der Lieferkette erst als erfuellt, wenn die jeweilige Oberflaeche
im gebauten Web-Artefakt nachweisbar vorhanden ist (`features-verify` in
`scripts/ops/deep_delivery.py`). Der Nachweis prueft vorhandene Oberflaechen, nicht
die Qualitaet einzelner Antworten; der Browser-Test kommt danach.
