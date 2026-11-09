#!/usr/bin/env python3
"""Deep-Projektordner der Villa 34 finden und Uebergabe-Artefakte pruefen.

Modus `discover` (Standard): gibt `DEEP_DIR=<pfad>` fuer $GITHUB_ENV aus und
zeigt den aktuellen Stand der Handover-Pruefungen.
Modus `--verify`: bricht ab, solange nicht alle Uebergabe-Pruefungen bestehen.

Der Ordner folgt der Regel des Hubs: DEEP_DIR (Default /opt/villaforge/deep)
plus Projekt-ID. Die Projekt-ID wird ueber die API bestimmt, nicht geraten.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("VF_HUB_BASE", "https://hub.cybersarah-ki.com")
DEEP_ROOT = os.environ.get("VF_DEEP_DIR", "/opt/villaforge/deep")
VILLA = int(os.environ.get("VF_VILLA_ID", "34"))


def call(path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    header = {"Content-Type": "application/json"}
    if token:
        header["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=header)
    with urllib.request.urlopen(req, timeout=45) as res:
        return json.load(res)


def login():
    email = os.environ.get("VF_ADMIN_EMAIL")
    password = os.environ.get("VF_ADMIN_PASSWORD")
    if not email or not password:
        raise SystemExit("VF_ADMIN_EMAIL/VF_ADMIN_PASSWORD fehlen")
    return call("/api/auth/login", {"email": email, "password": password})["token"]


def finde_projekt(token):
    try:
        liste = call("/api/deep/projects", token=token)
    except Exception as fehler:  # noqa: BLE001 - Diagnose statt Absturz
        print(f"Projektliste nicht lesbar: {fehler}", file=sys.stderr)
        return VILLA
    projekte = liste.get("projects", liste) if isinstance(liste, dict) else liste
    if not isinstance(projekte, list):
        return VILLA
    for eintrag in projekte:
        for feld in ("villa_id", "villaId"):
            if int(eintrag.get(feld) or 0) == VILLA:
                return int(eintrag.get("id"))
    ids = [int(e.get("id") or 0) for e in projekte if str(e.get("id", "")).isdigit()]
    return VILLA if VILLA in ids else (max(ids) if ids else VILLA)


def bericht(token, projekt_id):
    return call(f"/api/deep/projects/{projekt_id}/completion", token=token)


def main():
    pruefen = "--verify" in sys.argv[1:]
    token = login()
    projekt_id = finde_projekt(token)
    ordner = f"{DEEP_ROOT}/{projekt_id}"
    print(f"PROJEKT {projekt_id} | Ordnername {ordner}", file=sys.stderr)

    daten = bericht(token, projekt_id)
    handover = daten.get("handoverChecks") or {}
    villa = daten.get("villa") or {}
    print(f"VILLA {villa.get('id')} {villa.get('name')} status={villa.get('status')}", file=sys.stderr)
    print(f"handoverReady {daten.get('handoverReady')}", file=sys.stderr)
    for name, pruefung in handover.items():
        print(f"  HANDOVER {name}: {pruefung.get('status')} - {pruefung.get('evidence')}")

    if not handover:
        print("Keine Uebergabe-Pruefungen im Bericht", file=sys.stderr)
        if pruefen:
            print("HANDOVER-NICHT-BEWERTBAR")
            return 1
        print("DEEP_DIR=" + ordner)
        return 0

    offen = [n for n, p in handover.items() if p.get("status") != "passed"]
    if offen:
        print("HANDOVER-OFFEN " + ",".join(offen))
        if pruefen:
            return 1
        print("DEEP_DIR=" + ordner)
        return 0

    print("HANDOVER-ALLE-BESTANDEN " + str(len(handover)))
    print("DEEP_DIR=" + ordner)
    return 0


if __name__ == "__main__":
    sys.exit(main())
