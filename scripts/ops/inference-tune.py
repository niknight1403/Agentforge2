#!/usr/bin/env python3
"""Setzt die Kaskaden-Prioritaeten nach den gemessenen Knotenwerten.

Messung vom 01.11.2026 (Hub-Server, echter Lasttest):
  CAX41  7B   1,3 s   19,7 tok/s   <- schnellster Knoten
  CAX21-1 7B  3,6 s    7,4 tok/s
  CAX21-2 7B  4,3 s    6,6 tok/s
  CAX41  32B  5,5 s    4,6 tok/s   (nur fuer Architektur/Review)
  lokal   7B  52 s     0,6 tok/s   <- vom Hub-Thrashing ausgebremst
  lokal   3B  >90 s    Timeout

Ziel: Inferenz laeuft auf den entfernten Knoten, der Hub bleibt Steuerzentrale.
Das Skript ist idempotent und laesst sich jederzeit erneut ausfuehren.
"""
import sqlite3
import sys

DB = "/opt/villaforge/server/data/villaforge.db"

# (Teil des Routennamens, Zielprioritaet) - kleinere Zahl laeuft frueher.
WANTED = [
    ("CAX41 (7B schnell)", 1),
    ("CAX21-1 (7B)", 2),
    ("CAX21-2 (7B)", 3),
    ("CAX11 (3B)", 4),
    ("CAX41 (32B)", 20),
    ("LiteLLM Kaskade", 30),
    ("Ollama Oracle Cloud", 40),
    ("Ollama lokal", 50),
]


def main():
    try:
        con = sqlite3.connect(DB)
        rows = con.execute("select id, name, priority, model, base_url from routes where enabled=1").fetchall()
    except Exception as exc:  # noqa: BLE001
        print(f"Datenbank nicht lesbar: {exc}")
        return 1

    changes = []
    for needle, target in WANTED:
        for rid, name, priority, _model, _base in rows:
            if needle in name and priority != target:
                con.execute("update routes set priority=? where id=?", (target, rid))
                changes.append((name, priority, target))
    con.commit()

    print("== Prioritaeten ==")
    if changes:
        for name, old, new in changes:
            print(f"  {name[:40]:40s} {old} -> {new}")
    else:
        print("  bereits gesetzt, keine Aenderung")

    print("== Kaskadenreihenfolge (aktiv, aufsteigend) ==")
    ordered = con.execute(
        "select name, priority, model, base_url from routes where enabled=1 order by priority asc, id asc"
    ).fetchall()
    for name, priority, model, base in ordered[:14]:
        host = str(base).split("/")[2] if "://" in str(base) else str(base)
        print(f"  {priority:>3}  {str(name)[:38]:38s} {str(model)[:20]:20s} {host}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
