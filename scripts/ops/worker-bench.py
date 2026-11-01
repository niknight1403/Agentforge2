#!/usr/bin/env python3
"""Misst jeden Ollama-Knoten aus der Routen-Tabelle mit einem echten Lasttest.

Laeuft auf dem Hub-Server, damit die Messung aus Sicht des Hubs gilt.
Aufruf: sudo python3 /tmp/worker-bench.py
"""
import json
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

DB = "/opt/villaforge/server/data/villaforge.db"
PROMPT = "Erklaere in einem Satz, was ein Vektor ist."
LOCAL_MODELS = ["llama3.2:3b", "qwen2.5-coder:7b"]


def http_json(url, payload=None, timeout=90):
    """Ruft url auf und liefert (daten, dauer_ms, fehler)."""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
        return json.loads(raw), int((time.monotonic() - started) * 1000), None
    except urllib.error.HTTPError as exc:
        return None, int((time.monotonic() - started) * 1000), f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 - Netzfehler jeder Art
        return None, int((time.monotonic() - started) * 1000), type(exc).__name__


def measure(label, root, model):
    tags, tags_ms, tags_err = http_json(f"{root}/api/tags", timeout=8)
    if tags is None:
        print(f"{label:38s} {model:20s} tags={tags_ms:>6}ms  NICHT ERREICHBAR ({tags_err})")
        return
    available = [m.get("name") for m in tags.get("models", [])]
    has_model = "ja" if model in available else "nein"

    body = {"model": model, "prompt": PROMPT, "stream": False, "options": {"num_predict": 32}}
    answer, ms, err = http_json(f"{root}/api/generate", body, timeout=90)
    if answer is None:
        print(f"{label:38s} {model:20s} tags={tags_ms:>6}ms modell={has_model:4s} {ms:>6}ms  FEHLER {err}")
        return
    if answer.get("error"):
        print(f"{label:38s} {model:20s} tags={tags_ms:>6}ms modell={has_model:4s} {ms:>6}ms  FEHLER {str(answer['error'])[:40]}")
        return
    count = answer.get("eval_count") or 0
    dur = answer.get("eval_duration") or 0
    tps = round(count / (dur / 1e9), 1) if count and dur else 0.0
    text = " ".join(str(answer.get("response", "")).split())[:44]
    print(f"{label:38s} {model:20s} tags={tags_ms:>6}ms modell={has_model:4s} {ms:>6}ms {count:>4} tok {tps:>6} tok/s  {text}")


def main():
    try:
        con = sqlite3.connect(DB)
        rows = con.execute(
            "select name, base_url, model from routes where enabled=1 and base_url like '%11434%' order by id"
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        print(f"Datenbank nicht lesbar: {exc}")
        return 1

    print("== Knoten aus der Routen-Tabelle ==")
    seen = set()
    for name, base, model in rows:
        if not base:
            continue
        root = base[:-3].rstrip("/") if base.endswith("/v1") else base.rstrip("/")
        key = (root, model)
        if key in seen:
            continue
        seen.add(key)
        measure(str(name)[:38], root, model)

    print()
    print("== lokal geladene Modelle ==")
    ps, _, err = http_json("http://127.0.0.1:11434/api/ps", timeout=8)
    if ps is None:
        print(f"  keine Daten ({err})")
    else:
        models = ps.get("models", [])
        if not models:
            print("  keine Modelle geladen")
        for item in models:
            print(f"  {str(item.get('name')):26s} {round((item.get('size') or 0) / 1e9, 1)} GB")

    print()
    print("== lokaler Vergleich ==")
    for model in LOCAL_MODELS:
        measure("lokal 127.0.0.1:11434", "http://127.0.0.1:11434", model)

    print()
    print("== Speicher ==")
    subprocess.run(["free", "-m"], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
