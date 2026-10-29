# Verbindliche Designrichtung: Aurora (Variante 6)

Auswahl des Benutzers: die sechste im Chat angezeigte Generierung vom 29.10.2026. Keine andere Richtung ist freigegeben.

Repository-Referenz: `docs/design/aurora-reference.webp` (visuelle Referenz, keine UI-Implementierung).

Referenz-ID: exec-1bb4fd04-b5c8-400c-8176-b1ab201dbb5e.png. Figma-Entscheidungsboard: https://www.figma.com/design/4CEwgs2ZLkJ4zj9YOpSHdn (editierbare Entscheidungsnotizen; keine implementierten App-Screens).

## Visuelles Ziel

Tiefes Violett als ruhiger Hintergrund, Koralle fuer primaere Aktionen und Lavendel fuer Sekundaerinformationen. Keine animierten Aurora-Hintergruende. Eine echte, generierte Studio-Illustration begleitet das aktive Projekt. Die eigene Projektidee ersetzt die Vorschau-Beispieldaten.

## Tokens

- Background: #100C24
- Surface: #1C1730
- Text: #F3F0FF
- Muted: #BDB5D2
- Action/Accent: #FFA49B; Text darauf #241428
- Secondary: #B69AF7
- Success (nur mit Nachweis): #7DE8C4
- Radius: 18–24px; Touchziele mindestens 44px; primaere Aktion 56px
- Typografie: bestehendes Plus Jakarta Sans mit System-Fallback. Ueberschrift 30–48px, Body 14–16px, kurze Zeilen, keine neue Fontabhaengigkeit.

## Struktur und Verhalten

Projektwahl bleibt stabil. Darunter stehen Ergebnisziel, aktives Projekt und konkrete naechste Schritte. Projekt starten/pausieren ist die primaere Aktion; Details oeffnet den bestehenden Arbeitsbereich. Produktabnahme/Reifegrad, technische Modellmetriken und Aktivitaet sind aufklappbar. Hub, Modellantwort und Produktabnahme bleiben getrennte Fakten.

Navigation verwendet vorhandene echte Ziele: Heute, Projekte, Agenten, Konto. Die Vorschau-Bezeichnung Studio wird erst verwendet, wenn ein gleichwertiges eigenes Navigationsziel existiert; Design & Live bleibt im Projektarbeitsraum erreichbar. Kein kosmetisch umbenannter Agenten-Tab als angebliches Studio.

## Zustaende

Leeres Projekt, Laden, Bereit, Ausfuehrung, Queue, Modell-Warten, Fehler, Pausiert und nachgewiesene Produktabnahme. Keine Beispielwerte in Produktion. Keine Animation bei prefers-reduced-motion. Live-Updates erhalten Projektwahl, Fokus und laufende Bedienaktionen. Keine behaupteten riesigen Restlaufzeiten.

## Asset-Herkunft

Aurora-Studio und Aurora-Atmosphaere wurden fuer dieses Projekt mit dem integrierten Bildgenerator erzeugt. Auslieferung als komprimierte WebP-Dateien. Keine vollstaendige UI als Hintergrundbild.

## Abnahme

Browserpruefung bei 360, 390, 430 und 1440 CSS-Pixeln, gleiche Projekt-/UI-Zustaende, echte Interaktionen, Konsole, Fokus und Screenshotvergleich zur Referenz. Native Android-UIs benoetigen eine eigene Pruefung; Web-CSS allein belegt kein natives Redesign.
