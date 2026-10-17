#!/usr/bin/env python3
"""VillaForge Studio Phase 2: APK-Vorbereitung (App-Name, Icon-URL, Landing-Fallback).

Wird vom Workflow villa-apk.yml aufgerufen. Umgebungsvariablen:
  VILLA_NAME   Anzeigename der Villa (Pflicht)
  APP_NAME     Optionaler App-Name (ueberschreibt VILLA_NAME)
  WWW          Pfad zum Web-Root im APK-Template (Default: villa-apk-template/...)
  ART_DIR      Entpacktes Hub-Artefakt (Default: /tmp/art)

Aktionen:
  1. Setzt den App-Namen XML-sicher in strings.xml.
  2. Schreibt die Pollinations-Icon-URL nach /tmp/icon_url.txt.
  3. Fehlt im Web-Root eine index.html, wird eine Landing-Page aus dem
     Produkt-README erzeugt (Fallback statt leerer App).
"""
import os
import re
import glob

WWW = os.environ.get("WWW") or os.path.join(
    "villa-apk-template", "app", "src", "main", "assets", "www")
ART = os.environ.get("ART_DIR") or "/tmp/art"

name = (os.environ.get("APP_NAME") or os.environ.get("VILLA_NAME") or "Villa App").strip()

# 1) App-Name in strings.xml (XML-sicher, max. 28 Zeichen)
safe = re.sub(r"[<>&\"']", "", name)[:28] or "Villa App"
p = os.path.join(os.path.dirname(os.path.dirname(WWW)), os.pardir, "res", "values", "strings.xml")
p = os.path.join("villa-apk-template", "app", "src", "main", "res", "values", "strings.xml")
s = open(p, encoding="utf-8").read().replace("VILLA_APP_NAME", safe)
open(p, "w", encoding="utf-8").write(s)
print("App-Name:", safe)

# 2) Icon-URL (Pollinations, deterministischer Seed)
import urllib.parse
q = urllib.parse.quote(f"flat modern app icon, {name}, neon cyber style, dark background, minimalist logo, high contrast")
open("/tmp/icon_url.txt", "w").write(
    f"https://image.pollinations.ai/prompt/{q}?width=512&height=512&nologo=true&seed=42")
print("Icon-URL vorbereitet")

# 3) Landing-Fallback, wenn kein Web-Root existiert
idx = os.path.join(WWW, "index.html")
if not os.path.isfile(idx):
    import html
    readme = ""
    hits = sorted(glob.glob(os.path.join(ART, "**", "README.md"), recursive=True))
    if hits:
        readme = open(hits[0], encoding="utf-8", errors="replace").read()[:1500]
    body = html.escape(readme) if readme else "Das Produkt dieser Villa wird gerade fertiggestellt."
    page = (
        f'<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape(name)}</title>"
        f"<style>body{{background:#0A0E14;color:#e6f7ff;font-family:system-ui,sans-serif;margin:0;padding:32px;max-width:720px}}"
        f"h1{{color:#00FFD1;font-weight:700}}pre{{white-space:pre-wrap;color:#9fd7ff;font-size:13px}}</style></head>"
        f"<body><h1>{html.escape(name)}</h1><pre>{body}</pre></body></html>"
    )
    open(idx, "w", encoding="utf-8").write(page)
    print("Landing-Page generiert (kein Web-Root im Artefakt)")
else:
    print("Web-Root vorhanden:", idx)
