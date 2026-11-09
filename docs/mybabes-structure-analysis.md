# Strukturanalyse mybabes.ai (Stand 09.11.2026)

Zweck: belegte Grundlage, um die Integration in Agentforge2 praezise zu planen. Getrennt wird
ueberall zwischen **[belegt]** (an einer oeffentlichen Quelle gelesen, mit Datum) und
**[abgeleitet]** (Schluss aus mehreren Belegen, nicht direkt gelesen).

Quellen (alle oeffentlich, ohne Login, ohne Umgehung von Schutzmechanismen, abgerufen 09.11.2026):

| Quelle | Inhalt |
|---|---|
| `https://mybabes.ai/` (50.394 B HTML) | Navigation, Generator-Einstiege, Rechtslinks, 47 Tag-Links |
| `https://mybabes.ai/robots.txt` | gesperrte Bereiche je Sprache, Sitemap-Verweise, Hinweis auf Routenmanifest |
| `https://mybabes.ai/sitemap.xml` | Sitemap-Index mit 25 Shards |
| `sitemap-static.xml` | 1.700 statische URLs |
| `sitemap-hub-pages.xml` | 105 Hub-Seiten (35 Tags x 3 Ansichten) |
| `sitemap-babes-2026-10.xml` / `-2026-11.xml` | 16.677 / 4.295 Charakterseiten |
| `sitemap-chats-2026-11.xml` | 4.353 Chat-Seiten |
| `sitemap-posts-images-2026-11.xml` | 50.000 Bild-Post-Seiten (Sitemap-Obergrenze) |
| `sitemap-posts-videos-2026-11.xml` | 7.009 Video-Post-Seiten |
| `sitemap-stories.xml` | 754 Geschichten |
| `sitemap-events.xml` | 10 Events |
| `sitemap-users.xml` | 344 Creator-Profile |
| eine Charakterseite `/babes/<uuid>` (125.672 B) | JSON-LD `ItemPage` + `BreadcrumbList`, clientseitig gerendert |

Grenzen: Die Anwendung rendert clientseitig; Datenmodelle, API-Vertraege und Preise sind von aussen
nicht lesbar. Diese Analyse beschreibt deshalb die **Struktur** (Routen, Entitaeten, Achsen, Mengen),
nicht die Interna (Datenbankschema, Modellwahl, Kosten).

---

## 1. Was die Struktur eindeutig vorgibt [belegt]

1. **Alles Inhaltliche hat eine eigene, indexierbare Seite mit UUID-Slug.** Charaktere, Posts,
   Stories, Events und Chats sind eigene Entitaeten mit eigener Route (`/babes/<uuid>`,
   `/explore/post/<uuid>`, `/story/<uuid>`, `/explore/events/<uuid>`, `/reels/chat/<slug>`).
2. **Explore ist eine Matrix, kein Feed.** Achsen: Inhaltstyp (`babes`, `images`, `videos`,
   `stories`, `creators`, `events`) x Tag-Dimension x Wert, jeweils mit Unteransicht
   `/images` und `/videos`. Das erzeugt 105 Hub-Seiten aus 35 Tags.
3. **Tag-Taxonomie ist fest verdrahtet** (8 Dimensionen): `age`, `ethnicity`, `style`,
   `orientation`, `roleplay_type`, `fetishes`, `sex_position`, `video_model`.
   `video_model` als eigene Taxonomie bedeutet: Videogenerierung ist nach Modell filterbar,
   also Teil des oeffentlichen Inhaltsmodells, nicht nur ein Werkzeug.
4. **Generatoren sind eigenstaendige Produktflaechen**, teils doppelt gefuehrt
   (`/image-generator` und `/tools/image-generator`): Bild, Video, Video-Extender, Scene-Generator,
   Inpaint-Generator, Story-Creator, Character-Builder.
5. **Drei Charakter-Erstellpfade** statt einem: `/babes/create/her`, `/create/him`, `/create/gay`.
   Die Erstellung ist damit entlang der Orientierung strukturiert, nicht nur ein Formular.
6. **Geschuetzte Bereiche sind vom Crawler ausgeschlossen:** `/admin`, `/gallery`, `/settings`,
   `/babes/queue`. Der Queue-Pfad zeigt: Charakter-Erstellung laeuft asynchron ueber eine
   Warteschlange, nicht synchron im Request.
7. **Internationalisierung ist Teil der Route**, nicht ein Sprachschalter: 17 Sprachen plus
   `x-default` (`da, de, en, es, fi, fr, it, ja, ko, nb, nl, pl, pt-BR, pt-PT, vi, zh-Hans, zh-Hant`),
   gesperrte Bereiche existieren je Sprachpraefix (`/de/admin` usw.).
8. **SEO wird aus einem Routenmanifest generiert.** `robots.txt` sagt es woertlich:
   "Generated at build time from the route manifest SEO policies. Edit src/lib/seoMetadata.ts
   (renderGuiRobotsTxt)". Zusaetzlich ein Sitemap-Index mit Shards je Entitaet und Monat.
9. **Rechtliches ist vierseitig getrennt:** `/docs/terms`, `/docs/privacy`, `/docs/blocked`,
   `/docs/removal`, `/docs/verification`. Altersverifikation ist eine eigene Seite, also ein
   eigener Prozess.
10. **Frontend-Auslieferung versioniert:** Assets unter `/frontend-releases/<build-hash>/assets/...`,
    Bundles u. a. `vendor-tanstack`. Also SPA mit Build-Artefakten je Release.

## 2. Mengengeruest (Kapazitaetsplanung) [belegt]

| Entitaet | Menge (Shard) | Bedeutung fuer uns |
|---|---|---|
| Charaktere | 16.677 (10/2026), 4.295 (11/2026 bis 09.11.) | Content-Volumen waechst monatlich im vier- bis fuenfstelligen Bereich |
| Bild-Posts | 50.000 (11/2026, Sitemap-Obergrenze) | Bilder werden als eigene Posts gefuehrt, nicht als Anhang am Charakter |
| Video-Posts | 7.009 (11/2026) | Verhaeltnis Bild zu Video ca. 7:1 |
| Chats | 4.353 (11/2026) | Chats sind oeffentlich teilbar, also auch Content |
| Stories | 754 | kleiner Bestand, eigener Typ |
| Events | 10 | Nische, aber eigener Typ mit Detailseite |
| Creator-Profile | 344 | oeffentliche Profile, `become-creator` als Einstieg |
| Statische Seiten | 1.700 | inkl. `/reels/chat/<slug>` und `/reels/undress/<slug>` je Charakter |

## 3. Entitaetenmodell, das diese Routen erzwingen [abgeleitet, aus 1 + 2]

```
User            id, handle, display_name, avatar, is_creator, locale, created_at
Character       id(uuid), slug, name, headline, gender_path(her|him|gay),
                persona{backstory, personality, speech_style},
                appearance{prompt, anchors[]}, style_tag(realistic|anime),
                tags{age, ethnicity, orientation, roleplay_type, fetishes,
                     sex_position, style, video_model},
                cover_media_id, gallery_media_ids[], creator_id,
                visibility(public|private|queued), moderation_state, created_at
Chat            id, character_id, user_id, title, visibility, memory_summary,
                created_at, last_message_at
Message         id, chat_id, role(user|character|system), content,
                media_id?, tokens_used, model_id, created_at
Post            id(uuid), kind(image|video), character_id, creator_id, prompt,
                model_id, params{aspect, duration, seed, refs[]}, media_id,
                tags{}, moderation_state, likes, created_at
Media           id, owner_id, kind, storage_key, width/height/duration, bytes,
                hash, source(generated|uploaded), created_at
Story           id(uuid), title, character_id, chapters[{index, title, text, media_ids[]}],
                visual_anchor, visibility, created_at
Event           id(uuid), title, starts_at, ends_at, character_ids[], description, media_id
Tag / Hub       dimension, value, slug, content_counts{characters, images, videos}
TokenLedger     id, user_id, delta, reason(generation|purchase|refund), ref_id,
                balance_after, created_at
Subscription    id, user_id, plan, status, provider, period_start, period_end
GenerationJob   id, user_id, kind(image|video|extend|scene|inpaint), params,
                state(queued|running|done|failed), provider, cost, attempts, result_media_id
ModerationCase  id, subject_type, subject_id, reason, state, reporter_id, resolved_by
```

Zwingende Beziehungen: `Post -> Character` (Bilder gehoeren zu einer Figur),
`Character -> media` (Cover + Galerie), `Message -> Media` (Chat-Galerie),
`GenerationJob -> TokenLedger` (jede Erzeugung ist eine Buchung), `Character -> creator` (Creator-Bereich).

## 4. Funktionsmodule und ihre Abhaengigkeiten [abgeleitet]

| Modul | Haengt an | Ohne das geht es nicht |
|---|---|---|
| Explore-Matrix | Character, Post, Tag/Hub, Suche | Tag-Aggregate muessen mitwachsen, sonst entstehen leere Hub-Seiten |
| Character-Detail | Character, Media, Chat-Einstieg | stabile Medien-Referenzen |
| Chat | Character-Persona, Message-Store, LLM-Router, TTS/STT | Gedaechtnis-Zusammenfassung je Chat |
| Charakter-Erstellung | Builder, Queue, Bildpipeline, Moderation | asynchrone Verarbeitung (`/babes/queue`) |
| Bildgenerierung | Job-Queue, Token-Ledger, Objektspeicher | Idempotenz je Auftrag, sonst doppelte Abbuchung |
| Videogenerierung | dasselbe plus Modellwahl (`video_model`-Tags) | laengere Laufzeit, Statusabfrage, Kosten je Sekunde |
| Video-Extender / Inpaint / Scene | bestehendes Medium als Eingabe | Referenz-Upload und Rechtepruefung |
| Story-Creator | Character, Story, Medien | visueller Anker ueber Kapitel hinweg |
| Reels | Post(video), Chat-Slug | kurze Sequenzen, Autoplay |
| Creator-Bereich | User, Character, Post, Auszahlung | Sichtbarkeit, Moderation, Profilseite |
| Galerie / Queue / Settings | User, Media, GenerationJob | nur eingeloggt, bewusst nicht indexiert |
| Tokens/Abo | Ledger, Subscription, Zahlungsanbieter | Preis- und Guthabenlogik muss vor Generatoren stehen |
| Moderation/Legal | ModerationCase, Altersverifikation | Sperrlisten vor jeder Erzeugung |

## 5. Ist-Stand bei uns und die Luecken

Vorhanden (verifiziert): `docs/app/index.html` (39 KB, eine Datei, ohne Build), Live unter
`https://niknight1403.github.io/Agentforge2/app/`, Selbsttest 8/8 inklusive Lauf gegen die Live-Seite,
APK `MyBabes-Studio-20261109.apk` (24.487 B, Paketpruefung bestanden).
Damit sind Bedienfluss, Alterssperre, Builder, Chat mit Gedaechtnis, Galerie, Stimme,
Generator-Oberflaechen mit ehrlichem Zustand, Story, Creator, Token-Anzeige und Rechtsseiten
**als Oberflaeche** abgedeckt. Was fehlt, ist die Struktur dahinter.

| Luecke | Warum sie die Planung bestimmt | Aufwand |
|---|---|---|
| Kein Server-/Datenmodell (alles `localStorage`) | Ohne Character/Post/Message-Tabellen gibt es keine Explore-Matrix, keine Creator-Profile, keine geteilten Chats | L |
| Keine Entitaetsseiten (nur Tabs) | Jede Entitaet braucht eigene Route + Metadaten, sonst keine SEO-Struktur | M |
| Keine Tag-Taxonomie als Daten | 8 Dimensionen x Werte muessen Daten sein, nicht Filterliste im Code | S |
| Keine Job-Queue + Ledger | Generierung ohne Auftrag und Buchung ist nicht abrechenbar und nicht wiederholbar | L |
| Kein Objektspeicher/CDN fuer Medien | Bilder/Videos brauchen stabile URLs und Loeschpfade | M |
| Keine i18n-Routen | 17 Sprachen sind ein Routen- und Textsystem, kein Schalter | M |
| Keine Moderation/Altersverifikation als Prozess | Rechtlich Pflicht, technisch vor jeder Erzeugung | M |
| Kein Zahlungsanbieter | Tokens ohne Anbieter bleiben Anzeige (bei uns bewusst so benannt) | M |

## 6. Empfohlene Zielstruktur fuer Agentforge2 [Vorschlag, Council-faehig]

```
/apps/web            Routen (TanStack-artig), i18n, SEO-Manifest -> robots + Sitemap-Shards
/apps/api            REST: /characters /posts /chats /stories /jobs /tokens /creators /admin
/packages/db         Schema + Migrationen (User, Character, Post, Chat, Message, Story,
                     Event, Tag, Media, GenerationJob, TokenLedger, Subscription, ModerationCase)
/packages/gen        Anbieter-Adapter (image, video, extend, inpaint, scene) + Queue-Worker
/packages/moderation Sperrlisten, Altersstufen, Pruefungen vor jedem Auftrag
/packages/ui         gemeinsame Komponenten (Karten, Filter, Chatfenster)
```

Datenfluss Generierung (der kritische Pfad):
`Anfrage -> Guthaben pruefen (Ledger) -> Auftrag anlegen (idempotent) -> Queue -> Anbieter ->
Medien speichern -> Post anlegen -> Auftrag done -> Ledger final buchen -> Hub-Aggregate aktualisieren`.
Ohne Schritt "Ledger final buchen" sind Retries doppelte Kosten; ohne Hub-Aktualisierung
entstehen leere Tag-Seiten.

## 7. Reihenfolge mit Abnahmekriterien

1. **Datenmodell + Migrationen** (Character, Post, Chat/Message, Story, Tag, Media, Job, Ledger).
   Abnahme: Migration laeuft, Tests decken Constraints ab.
2. **API + Auth** (Lesen oeffentlich, Schreiben mit Konto, Admin getrennt).
   Abnahme: Vertragstests, 401/403-Faelle, Rate-Limits.
3. **Explore-Matrix auf echten Daten** inkl. Tag-Aggregaten.
   Abnahme: 35 Tags x 3 Ansichten liefern korrekte Zaehler; leere Ansichten zeigen leeren Zustand.
4. **Chat mit Gedaechtnis** (Message-Store + Zusammenfassung + Sprachausgabe/-eingabe).
   Abnahme: Verlauf ueber Geraetewechsel hinweg, Gedaechtnis nachvollziehbar.
5. **Generierung mit Queue, Ledger und ehrlichem Zustand** (Bild zuerst, dann Video, dann Extender/Inpaint).
   Abnahme: Auftrag wiederholbar, Kosten je Auftrag gebucht, Fehler sichtbar.
6. **Creator, Reels, Stories, Events** auf denselben Entitaeten.
   Abnahme: Veroeffentlichen/Zurueckziehen wirkt auf Explore.
7. **i18n + SEO-Manifest** (Routen, hreflang, robots aus Manifest, Sitemap-Shards).
   Abnahme: jede Entitaet eine Seite mit Metadaten, robots sperrt Konto-Bereiche.
8. **Moderation + Altersverifikation + Zahlungsanbieter.**
   Abnahme: Sperrliste greift vor Erzeugung, Verifikation nachweisbar, Ledger bucht Kauf.

## 8. Was wir bewusst nicht uebernehmen

- Keine Inhalte, Texte, Bilder, Namen oder Daten von mybabes.ai. Uebernommen wird die
  Funktions- und Strukturidee, umgesetzt mit eigenen Daten und eigenem Code.
- Keine `age/teen`-Kategorie und keine entsprechenden Tags. Bei uns bleibt es bei
  volljaehrigen Figuren (18+), die Altersabfrage ist Pflicht.
- Keine Uebernahme der Tag-Werte in problematischen Dimensionen; wir starten mit einer
  eigenen, kleinen Taxonomie (Stil, Genre, Rolle, Setting) und erweitern nur mit Beleg.

## 9. Offene Entscheidungen (blockieren die Struktur, nicht die Oberflaeche)

1. **Hosting/DB**: eigener Dienst (Postgres + Objektspeicher) oder Hub-Erweiterung?
2. **Generierungsanbieter**: welcher Bild-/Videoanbieter, welches Kostenmodell je Auftrag?
3. **Zahlungen**: Anbieter und Waehrung, bevor Tokens mehr als Anzeige sind?
4. **i18n-Umfang**: alle 17 Sprachen oder Start mit de/en und Manifest-vorbereiteter Struktur?
5. **Altersverifikation**: Selbstauskunft, Dokument oder Anbieter-Zertifikat?

Diese fuenf Punkte entscheiden ueber Aufwand und Reihenfolge; ohne sie bleibt die Integration
eine Oberflaeche ohne Struktur.
