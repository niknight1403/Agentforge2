# Aurora Design-QA

## Vergleich und Zustand

- Visuelle Wahrheit: `docs/design/aurora-reference.webp`, sechste im Chat angezeigte Generierung.
- Browsergerenderter Nachweis: `artifacts/aurora-qa/mobile-390-final.png`; Quelle der Aufnahme `/workspace/scratch/aurora-mobile-final-20261029.jpg`.
- Gemeinsamer Vergleich: `artifacts/aurora-qa/comparison-final.png` (Referenz links, gerenderte App rechts). Fruehere Iteration: `artifacts/aurora-qa/comparison.png`.
- Normalisierung: Referenz auf 390x844; Browser-Iframe mit echtem CSS-Viewport 390x844 bei Dichte 1, Screenshot aus x=383,y=49 in 390x844 ausgeschnitten. Kein Phone-Frame. Zusaetzliche sichtbare Ansichten: 360x844 und 430x844; Desktop separat in Browser-CI 1440x960.
- Unterschiedlicher Inhalt/Zustand: Referenz zeigt fiktives StudioSet/Bereit; Implementierung das isolierte Aurora-Testprojekt/Pausiert. Preview-Banner und Projektwaehler sind absichtlich zusaetzlich sichtbar; sie sind keine Produktionsdaten. Produktfunktionen und echte Projektwahl werden nicht fuer Pixelgleichheit entfernt.

## Vergleichshistorie

1. P2: Projektbeschreibung, Badges und umfangreiche Vorschlagsmetadaten drueckten die Hauptaktion unter die mobile Navigation. Korrektur: zweizeilige Projektzusammenfassung, Metadaten in den bestehenden Details, kompaktere Abstaende. Vollstaendige Abnahmekriterien bleiben im Projektarbeitsraum.
2. P2: Ueberschrift wich im Zeilenrhythmus ab. Korrektur: mobile 32px, maximale Breite 300px, zweizeiliger Rhythmus.
3. P2: Modellzustand war nur unterhalb der ersten Ansicht sichtbar. Korrektur: eigene ehrliche Modellstatuszeile direkt vor Start/Pause.
4. Nachkorrektur: finaler Screenshot zeigt Start/Details bei 360/390/430px vor der festen Navigation, keine sichtbare Ueberdeckung. Primaere Bedienflaechen bleiben mindestens 44px hoch.

## Fuenf Pruefflaechen

- Typografie: bestehendes Plus Jakarta Sans, System-Fallback; schwere, zweizeilige Ergebnisueberschrift und lesbare Produkt-/Aufgabentexte. Kein neuer Fontwechsel.
- Abstaende: konsistente 14–20px Gruppierung; Projekt, naechster Schritt und Handlung bilden den Hauptfluss. Technische Anzeigen liegen hinter Details oder weiter unten.
- Farben: Violett #100C24, Flaechen #1C1730, Koralle #FFA49B und Lavendel. Statusgruen ist semantisch, nicht Dekoration. Audit misst Kontrast zusaetzlich.
- Bilder: eigene generierte Aurora-Atmosphaere und Studio-Illustration, als kleine WebP-Assets. Keine vollstaendige UI als Hintergrundgrafik. Keine animierten Aurora-Flaechen.
- Copy: echte Projekt- und Aufgabentexte statt StudioSet-Platzhaltern. Start/Pause und Produktabnahme bleiben getrennt. Modellstatus bleibt bei fehlendem Nachweis ungeprueft.

## Gepruefte Interaktionen und Grenzen

Im Cloud-Browser: leere Ansicht, Projektanlage mit explizitem lokalem Modell-Fixture, Projektstopp, Rueckkehr ins Cockpit. Browser-CI prueft Navigation, Arbeitsraum, Chat, Start/Stopp und responsive Darstellung. Konsole auf App-Fehler geprueft; die Erweiterungs-Metadatenwarnung stammt vom Browser-Plugin. Keine Behauptung von Screenreader-Konformitaet, realem Produktionsprodukt oder nativer Android-Screenshotabnahme.

Fokussierter Vergleich: primaere Kontrolle, Projektkarte, Kopfzeile und Navigation sind im 390px-Doppelbild lesbar. Beabsichtigte Anpassungen: realer Projektwaehler, gleichwertige Start/Details-Zeile und vorhandenes Agenten-Navigationsziel; Studio bleibt im echten Projektarbeitsraum erreichbar. Keine fingierte Mediennavigation.

## Implementation Checklist

- [x] Bindende Aurora-Richtung und Referenz gespeichert.
- [x] Bestehende APIs/Projektsteuerung integriert.
- [x] Korrigierte mobile Ansichten visuell verglichen.
- [x] Kein verbleibender sichtbarer P0/P1/P2-Befund im geprueften Cockpit.
- [ ] Produktions-LLM und echtes Villa-Produkt separat abnehmen.
- [ ] Native Android-Struktur und Screenreader separat abnehmen.

P3: native Android-Struktur weiter an das Web-Cockpit angleichen; kein Pixelgleichheitsversprechen fuer diese getrennte Oberflaeche.

final result: passed
