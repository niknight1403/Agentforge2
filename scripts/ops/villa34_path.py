#!/usr/bin/env python3
"""Projektordner der Zielvilla ueber die Hub-API ermitteln.

Gibt eine Zeile `PROJEKT_DIR=<pfad>` aus, damit der Workflow sie in $GITHUB_ENV
uebernehmen kann. Ohne Treffer bleibt der Wert leer und das SSH-Skript sucht
selbst weiter.
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("VF_HUB_BASE", "https://hub.cybersarah-ki.com")
VILLA = os.environ.get("VF_VILLA_ID", "34")


def call(path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    header = {"Content-Type": "application/json"}
    if token:
        header["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=header)
    with urllib.request.urlopen(req, timeout=45) as res:
        return json.load(res)


def main():
    email = os.environ.get("VF_ADMIN_EMAIL")
    password = os.environ.get("VF_ADMIN_PASSWORD")
    if not email or not password:
        print("PROJEKT_DIR=")
        print("Keine Zugangsdaten, ueberspringe Abfrage", file=sys.stderr)
        return 0
    tok = call("/api/auth/login", {"email": email, "password": password})["token"]
    antwort = call(f"/api/villas/{VILLA}", token=tok)
    villa = antwort.get("villa", antwort) if isinstance(antwort, dict) else {}
    pfad = ""
    for feld in ("source_path", "sourcePath", "project_dir", "dir", "path"):
        wert = villa.get(feld)
        if isinstance(wert, str) and wert.strip():
            pfad = wert.strip()
            break
    print(f"VILLA {villa.get('id')} {villa.get('name')} status={villa.get('status')}", file=sys.stderr)
    print(f"FELDER {','.join(sorted(villa.keys()))[:300]}", file=sys.stderr)
    print("PROJEKT_DIR=" + pfad)
    return 0


if __name__ == "__main__":
    sys.exit(main())
