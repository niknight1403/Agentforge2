#!/usr/bin/env python3
"""Misst den Master-Chat gegen den laufenden Hub.

Erwartet VF_ADMIN_EMAIL und VF_ADMIN_PASSWORD in der Umgebung und
VF_HUB_URL (Standard http://127.0.0.1:12000).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VF_HUB_URL", "http://127.0.0.1:12000").rstrip("/")
EMAIL = os.environ.get("VF_ADMIN_EMAIL", "")
PASSWORD = os.environ.get("VF_ADMIN_PASSWORD", "")
RUNS = int(os.environ.get("VF_BENCH_RUNS", "4"))
MESSAGE = "Antworte ausschliesslich mit einem kurzen Satz, dass die Modellverbindung geprueft ist."


def call(path, payload=None, token=None, timeout=180):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = json.loads(response.read())
        return body, int((time.monotonic() - started) * 1000), None
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read())
        except Exception:  # noqa: BLE001
            body = {}
        return body, int((time.monotonic() - started) * 1000), f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return {}, int((time.monotonic() - started) * 1000), type(exc).__name__


def main():
    if not EMAIL or not PASSWORD:
        print("Admin-Zugang fehlt in der Umgebung.")
        return 1
    login, login_ms, login_err = call("/api/auth/login", {"email": EMAIL, "password": PASSWORD}, timeout=30)
    token = login.get("token")
    if not token:
        print(f"Login fehlgeschlagen: {login_err} {str(login)[:120]}")
        return 1
    print(f"Login ok ({login_ms} ms)")

    ok_count = 0
    for run in range(1, RUNS + 1):
        body, ms, err = call(
            "/api/master/chat",
            {"message": MESSAGE, "requestId": f"bench-{int(time.time() * 1000)}-{run}"},
            token=token,
        )
        attempts = body.get("routeAttempts") or []
        used = ""
        if attempts:
            used = " | ".join(f"{str(a.get('route'))[:22]}={a.get('code')}" for a in attempts[:6])
        ok = body.get("ok") is True
        ok_count += 1 if ok else 0
        answer = " ".join(str(body.get("answer", "")).split())[:46]
        print(f"  Lauf {run}: ok={ok} {ms:>6} ms {err or ''}")
        if used:
            print(f"          Versuche: {used}")
        if ok:
            print(f"          Antwort: {answer}")
            route = body.get("route") or body.get("model") or ""
            if route:
                print(f"          Route: {str(route)[:80]}")

    print(f"== Ergebnis: {ok_count}/{RUNS} erfolgreich ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
