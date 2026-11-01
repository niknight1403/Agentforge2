#!/usr/bin/env python3
"""
Versendet die vorbereitete Akquise-Welle ueber die Gmail-API.

Sicherungen:
  - Ohne --senden laeuft nur ein Dry-Run (zeigt, was rausgehen wuerde).
  - Tageslimit (Standard 30) verhindert Massenversand und schuetzt die Zustellbarkeit.
  - Jede gesendete Nachricht wird in sent.csv protokolliert; bereits versendete
    Eintraege werden nie ein zweites Mal geschickt.
  - Faellige Nachrichten werden nach Datum gefiltert (Stufe 1 zuerst).

Voraussetzungen:
  - Gmail-Connector ist autorisiert; Token liegt als $GMAIL_ACCESS_TOKEN vor.
    (Hole ihn mit get_connector_token fuer gmail, Scope gmail.send.)
  - Absenderadresse in $ABSENDER_MAIL (Standard: kontakt@anfragepilot.de).

Aufruf:
  python3 scripts/send_wave.py outbound/manifest.csv --limit 30            # Dry-Run
  python3 scripts/send_wave.py outbound/manifest.csv --limit 30 --senden    # scharf
"""
import argparse
import base64
import csv
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


def token():
    t = os.environ.get("GMAIL_ACCESS_TOKEN", "").strip()
    if not t:
        sys.exit("Kein GMAIL_ACCESS_TOKEN gesetzt. Erst den Gmail-Connector autorisieren "
                 "und das Token bereitstellen (Scope: gmail.send).")
    return t


def sende(roh_eml: str, tok: str):
    nachricht = base64.urlsafe_b64encode(roh_eml.encode("utf-8")).decode("ascii")
    daten = json.dumps({"raw": nachricht}).encode("utf-8")
    anfrage = urllib.request.Request(
        GMAIL_SEND,
        data=daten,
        method="POST",
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(anfrage, timeout=30) as antwort:
        return json.loads(antwort.read().decode() or "{}")


def lade_gesendet(pfad: Path):
    if not pfad.exists():
        return set()
    with open(pfad, newline="", encoding="utf-8") as f:
        return {(z["email"], z["stufe"]) for z in csv.DictReader(f)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("manifest")
    p.add_argument("--limit", type=int, default=30, help="maximale Sendungen pro Lauf")
    p.add_argument("--stufe", type=int, default=1, help="welche Stufe versendet wird")
    p.add_argument("--senden", action="store_true", help="ohne dieses Flag nur Dry-Run")
    args = p.parse_args()

    manifest = Path(args.manifest)
    if not manifest.exists():
        sys.exit(f"Manifest nicht gefunden: {manifest}")
    protokoll = manifest.parent / "sent.csv"
    bereits = lade_gesendet(protokoll)

    with open(manifest, newline="", encoding="utf-8") as f:
        zeilen = list(csv.DictReader(f))

    heute = date.today().isoformat()
    faellig = [
        z for z in zeilen
        if int(z["stufe"]) == args.stufe
        and z["faellig_am"] <= heute
        and (z["email"], z["stufe"]) not in bereits
    ]

    print(f"Faellig (Stufe {args.stufe}, bis {heute}): {len(faellig)} von {len(zeilen)} Eintraegen")
    auswahl = faellig[:args.limit]
    if len(faellig) > args.limit:
        print(f"Tageslimit greift: {len(faellig) - args.limit} bleiben fuer den naechsten Lauf.")

    if not args.senden:
        for z in auswahl:
            print(f"  [Dry-Run] {z['firma']} <{z['email']}>: {z['betreff'][:70]}")
        print("\nNichts gesendet. Fuer den echten Versand --senden ergaenzen.")
        return

    tok = token()
    kopf = ["zeitpunkt", "firma", "email", "stufe", "betreff", "status", "id"]
    neu = not protokoll.exists()
    with open(protokoll, "a", newline="", encoding="utf-8") as f:
        schreiber = csv.writer(f)
        if neu:
            schreiber.writerow(kopf)
        gesendet = 0
        for z in auswahl:
            datei = Path(z["datei"])
            if not datei.exists():
                print(f"  Fehlt: {datei}")
                continue
            try:
                antwort = sende(datei.read_text(encoding="utf-8"), tok)
                schreiber.writerow([date.today().isoformat(), z["firma"], z["email"],
                                    z["stufe"], z["betreff"], "gesendet", antwort.get("id", "")])
                gesendet += 1
                print(f"  gesendet: {z['firma']}")
            except urllib.error.HTTPError as e:
                fehler = e.read().decode()[:200]
                schreiber.writerow([date.today().isoformat(), z["firma"], z["email"],
                                    z["stufe"], z["betreff"], f"fehler {e.code}", fehler])
                print(f"  Fehler bei {z['firma']}: HTTP {e.code}")
    print(f"\nFertig: {gesendet} Nachricht(en) gesendet, Protokoll: {protokoll}")


if __name__ == "__main__":
    main()
