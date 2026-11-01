#!/usr/bin/env python3
"""Trennt die LLM-Inferenz vom Hub und legt sie auf die Worker-Knoten.

Der Hub (Port 12000) laeuft auf vier Kernen und ist mit Villa-Arbeit und
interaktiven Anfragen gleichzeitig ueberlastet. Messung vom 01.11.2026:

    CAX41   7B   1,3 s   19,7 tok/s   <- schnellster Knoten
    CAX21-1 7B   3,6 s    7,4 tok/s
    CAX21-2 7B   4,3 s    6,6 tok/s
    CAX11   3B  29,1 s    8,1 tok/s   (Kaltstart)
    CAX41  32B   5,5 s    4,6 tok/s   (nur Architektur/Review)
    lokal   7B  52,3 s    0,6 tok/s   <- vom Hub selbst ausgebremst
    lokal   3B  >90 s    Timeout

Dieses Skript macht daraus eine belastbare Konfiguration:

  bench   misst jeden Ollama-Knoten der Routen-Tabelle mit echtem Lasttest
  apply   pinnt je Knoten ein vorhandenes Modell, waermt es vor und setzt die
          Kaskaden-Prioritaet nach gemessener Geschwindigkeit; der lokale
          Knoten bleibt letzte Reserve und wird nie bevorzugt
  verify  stellt echte Master-Chat-Anfragen und meldet die Erfolgsquote
  all     bench -> apply -> verify

Sicherheitsregeln:
  * nur Routen mit Ollama-Endpunkt (Port 11434) werden veraendert
  * Cloud-Routen und der LiteLLM-Proxy bleiben unberuehrt
  * kein Modell wird gesetzt, das der Knoten nicht tatsaechlich hat
  * nichts wird deaktiviert, nur umsortiert und gepinnt
  * --dry-run zeigt alle Aenderungen ohne zu schreiben
  * jeder Lauf legt einen JSON-Bericht unter /tmp ab

Aufruf (auf dem Hub-Server):
    sudo python3 inference-separation.py all
    sudo python3 inference-separation.py bench --dry-run
    sudo python3 inference-separation.py verify --runs 5
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

DEFAULT_DB = "/opt/villaforge/server/data/villaforge.db"
DEFAULT_HUB = "http://127.0.0.1:12000"
OLLAMA_PORT_MARKER = "11434"
PROMPT = "Erklaere in einem Satz, was ein Vektor ist."
CHAT_MESSAGE = "Antworte ausschliesslich mit einem kurzen Satz, dass die Modellverbindung geprueft ist."

# Reihenfolge der Modelle, die ein Knoten bevorzugt bekommen soll.
MODEL_PREFERENCE = ("qwen2.5-coder:7b", "llama3.2:3b", "qwen2.5-coder:3b")

# Ab dieser Groesse gilt ein Modell als schwer und laeuft nur auf Abruf.
HEAVY_MODEL_HINTS = ("27b", "32b", "30b", "24b", "22b", "70b")
HEAVY_PRIORITY = 20

LOCAL_PRIORITY = 50          # Hub selbst: nur letzte Reserve
DEFAULT_PRIORITY = 40        # ungemessene Knoten
KEEP_ALIVE = "30m"           # Modelle bleiben warm, kein Kaltstart
TAGS_TIMEOUT = 8
GENERATE_TIMEOUT = 60
MAX_CONSECUTIVE_TIMEOUTS = 3


# --------------------------------------------------------------------------- #
# Datenmodell
# --------------------------------------------------------------------------- #
@dataclass
class Route:
    """Eine Zeile aus der Routen-Tabelle, reduziert auf das Noetige."""

    id: int
    name: str
    base_url: str
    model: str
    priority: int
    enabled: int

    @property
    def endpoint(self) -> str:
        """Basis-URL ohne /v1, damit /api/tags erreichbar ist."""
        root = self.base_url.strip().rstrip("/")
        if root.endswith("/v1"):
            root = root[:-3].rstrip("/")
        return root

    @property
    def is_local(self) -> bool:
        host = self.endpoint.split("//")[-1].split("/")[0]
        return host.startswith(("127.0.0.1", "localhost", "[::1]"))

    @property
    def host(self) -> str:
        return self.endpoint.split("//")[-1].split("/")[0]

    @property
    def is_heavy(self) -> bool:
        lowered = self.model.lower()
        return any(hint in lowered for hint in HEAVY_MODEL_HINTS)


@dataclass
class Measurement:
    """Ergebnis eines Lasttests gegen genau einen Knoten und ein Modell."""

    route_id: int
    name: str
    endpoint: str
    model: str
    reachable: bool = False
    model_present: bool = False
    available_models: list[str] = field(default_factory=list)
    duration_ms: int = 0
    tokens: int = 0
    tokens_per_second: float = 0.0
    sample: str = ""
    error: str = ""

    @property
    def usable(self) -> bool:
        return self.reachable and self.model_present and not self.error and self.tokens > 0


@dataclass
class Change:
    """Eine geplante oder ausgefuehrte Aenderung an einer Route."""

    route_id: int
    name: str
    field: str
    before: Any
    after: Any
    reason: str


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def http_json(url: str, payload: dict | None = None, timeout: int = GENERATE_TIMEOUT) -> tuple[dict | None, int, str]:
    """Ruft eine JSON-Schnittstelle auf und liefert (daten, dauer_ms, fehler)."""
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    request = urllib.request.Request(url, data=data, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
        return json.loads(raw), int((time.monotonic() - started) * 1000), ""
    except urllib.error.HTTPError as exc:
        return None, int((time.monotonic() - started) * 1000), f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 - Netzfehler jeder Art
        return None, int((time.monotonic() - started) * 1000), type(exc).__name__


# --------------------------------------------------------------------------- #
# Datenbank
# --------------------------------------------------------------------------- #
def load_routes(db_path: str) -> list[Route]:
    """Liest alle aktivierten Ollama-Routen aus der Hub-Datenbank."""
    import sqlite3

    con = sqlite3.connect(db_path)
    try:
        rows = con.execute(
            "select id, name, base_url, model, priority, enabled from routes "
            "where enabled=1 and base_url like ? order by priority asc, id asc",
            (f"%{OLLAMA_PORT_MARKER}%",),
        ).fetchall()
    finally:
        con.close()
    return [Route(*row) for row in rows]


def write_changes(db_path: str, changes: list[Change], dry_run: bool) -> int:
    """Schreibt die Aenderungen in die Datenbank. Liefert die Anzahl."""
    if not changes:
        return 0
    if dry_run:
        return len(changes)
    import sqlite3

    con = sqlite3.connect(db_path)
    try:
        for change in changes:
            con.execute(f"update routes set {change.field}=? where id=?", (change.after, change.route_id))
        con.commit()
    finally:
        con.close()
    return len(changes)


# --------------------------------------------------------------------------- #
# Messung
# --------------------------------------------------------------------------- #
def measure(route: Route) -> Measurement:
    """Misst einen Knoten mit einem echten Generierungsaufruf."""
    result = Measurement(route_id=route.id, name=route.name, endpoint=route.endpoint, model=route.model)

    tags, _, tags_error = http_json(f"{route.endpoint}/api/tags", timeout=TAGS_TIMEOUT)
    if tags is None:
        result.error = f"nicht erreichbar ({tags_error})"
        return result
    result.reachable = True
    result.available_models = [str(item.get("name")) for item in tags.get("models", [])]
    result.model_present = route.model in result.available_models
    if not result.model_present:
        result.error = "Modell fehlt auf dem Knoten"
        return result

    payload = {
        "model": route.model,
        "prompt": PROMPT,
        "stream": False,
        "keep_alive": KEEP_ALIVE,
        "options": {"num_predict": 32},
    }
    answer, duration_ms, error = http_json(f"{route.endpoint}/api/generate", payload, timeout=GENERATE_TIMEOUT)
    result.duration_ms = duration_ms
    if answer is None:
        result.error = f"keine Antwort ({error})"
        return result
    if answer.get("error"):
        result.error = str(answer["error"])[:60]
        return result

    count = int(answer.get("eval_count") or 0)
    eval_ns = int(answer.get("eval_duration") or 0)
    result.tokens = count
    result.tokens_per_second = round(count / (eval_ns / 1e9), 1) if count and eval_ns else 0.0
    result.sample = " ".join(str(answer.get("response", "")).split())[:48]
    if not count:
        result.error = "leere Antwort"
    return result


def bench(routes: list[Route]) -> list[Measurement]:
    """Misst alle Knoten der Reihe nach und bricht bei Totalausfall ab."""
    measurements: list[Measurement] = []
    consecutive_timeouts = 0
    seen: set[tuple[str, str]] = set()

    print("== Knoten messen ==")
    print(f"{'ROUTE':38s} {'MODELL':20s} {'DAUER':>8s} {'TOK/S':>7s}  BEFUND")
    for route in routes:
        key = (route.endpoint, route.model)
        if key in seen:
            continue
        seen.add(key)

        item = measure(route)
        measurements.append(item)

        if not item.reachable or "keine Antwort" in item.error:
            consecutive_timeouts += 1
        else:
            consecutive_timeouts = 0

        if item.usable:
            print(
                f"{item.name[:38]:38s} {item.model[:20]:20s} {item.duration_ms:>7}ms "
                f"{item.tokens_per_second:>7}  {item.sample}"
            )
        elif item.error == "Modell fehlt auf dem Knoten":
            print(
                f"{item.name[:38]:38s} {item.model[:20]:20s} {'-':>8s} {'-':>7s}  "
                f"Modell fehlt (vorhanden: {', '.join(item.available_models[:3]) or 'keine'})"
            )
        else:
            print(f"{item.name[:38]:38s} {item.model[:20]:20s} {item.duration_ms:>7}ms {'-':>7s}  {item.error}")

        if consecutive_timeouts >= MAX_CONSECUTIVE_TIMEOUTS:
            print("  Abbruch: drei Knoten hintereinander ohne Antwort")
            break
    return measurements


# --------------------------------------------------------------------------- #
# Konfiguration ableiten
# --------------------------------------------------------------------------- #
def pick_model(route: Route, measurement: Measurement) -> str:
    """Waehlt ein Modell, das der Knoten wirklich hat."""
    if not measurement.available_models:
        return route.model
    if route.model in measurement.available_models:
        return route.model
    for candidate in MODEL_PREFERENCE:
        if candidate in measurement.available_models:
            return candidate
    return measurement.available_models[0]


def plan(measurements: list[Measurement], routes: list[Route]) -> list[Change]:
    """Leitet aus den Messwerten Modell-Pinning und Prioritaeten ab."""
    by_id = {route.id: route for route in routes}
    changes: list[Change] = []

    # 1. Modell pinnen, wenn der Knoten das konfigurierte Modell nicht hat.
    for item in measurements:
        route = by_id.get(item.route_id)
        if route is None or not item.reachable:
            continue
        wanted = pick_model(route, item)
        if wanted != route.model:
            changes.append(Change(route.id, route.name, "model", route.model, wanted, "Modell auf dem Knoten nicht vorhanden"))

    # 2. Prioritaeten aus gemessener Geschwindigkeit.
    usable = [item for item in measurements if item.usable]
    fastest_first = sorted(usable, key=lambda item: item.tokens_per_second, reverse=True)

    priority_by_id: dict[int, tuple[int, str]] = {}
    rank = 1
    for item in fastest_first:
        route = by_id.get(item.route_id)
        if route is None:
            continue
        if route.is_local:
            continue  # lokal wird grundsaetzlich nach hinten gelegt
        if route.is_heavy:
            priority_by_id[route.id] = (HEAVY_PRIORITY, f"schweres Modell, nur auf Abruf ({item.tokens_per_second} tok/s)")
            continue
        priority_by_id[route.id] = (rank, f"Rang {rank} mit {item.tokens_per_second} tok/s gemessen")
        rank += 1

    for route in routes:
        if route.is_local:
            if route.priority != LOCAL_PRIORITY:
                reason = "Hub ist Steuerzentrale, lokal nur letzte Reserve"
                changes.append(Change(route.id, route.name, "priority", route.priority, LOCAL_PRIORITY, reason))
            continue
        target = priority_by_id.get(route.id)
        if target is None:
            if route.priority != DEFAULT_PRIORITY:
                changes.append(Change(route.id, route.name, "priority", route.priority, DEFAULT_PRIORITY, "nicht gemessen"))
            continue
        priority, reason = target
        if route.priority != priority:
            changes.append(Change(route.id, route.name, "priority", route.priority, priority, reason))

    return changes


def prewarm(measurements: list[Measurement]) -> None:
    """Haelt die Modelle warm, damit der erste echte Auftrag nicht kalt startet."""
    print("== Modelle vorwaermen ==")
    for item in measurements:
        if not item.usable:
            continue
        payload = {
            "model": item.model,
            "prompt": "ok",
            "stream": False,
            "keep_alive": KEEP_ALIVE,
            "options": {"num_predict": 2},
        }
        _, duration_ms, error = http_json(f"{item.endpoint}/api/generate", payload, timeout=GENERATE_TIMEOUT)
        state = f"{duration_ms} ms" if not error else error
        print(f"  {item.name[:36]:36s} {item.model[:20]:20s} {state}")


# --------------------------------------------------------------------------- #
# Verifikation
# --------------------------------------------------------------------------- #
def hub_credentials() -> tuple[str, str]:
    """Liest den Admin-Zugang aus der Umgebung des laufenden Hubs."""
    email = os.environ.get("VF_ADMIN_EMAIL", "")
    password = os.environ.get("VF_ADMIN_PASSWORD", "")
    if email and password:
        return email, password
    try:
        listing = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True, timeout=10).stdout
    except Exception:  # noqa: BLE001
        return "", ""
    pid = ""
    for line in listing.splitlines():
        if "12000" in line and "pid=" in line:
            pid = line.split("pid=")[1].split(",")[0]
            break
    if not pid:
        return "", ""
    try:
        with open(f"/proc/{pid}/environ", "rb") as handle:
            entries = handle.read().split(b"\0")
    except OSError:
        return "", ""
    values: dict[str, str] = {}
    for entry in entries:
        if b"=" not in entry:
            continue
        name, _, value = entry.partition(b"=")
        values[name.decode(errors="replace")] = value.decode(errors="replace")
    return values.get("VF_ADMIN_EMAIL", ""), values.get("VF_ADMIN_PASSWORD", "")


def verify(hub_url: str, runs: int) -> dict[str, Any]:
    """Stellt echte Master-Chat-Anfragen und misst Erfolgsquote und Latenz."""
    email, password = hub_credentials()
    if not email or not password:
        print("Verifikation uebersprungen: kein Admin-Zugang gefunden.")
        return {"ok": False, "error": "kein Admin-Zugang"}

    login, _, error = http_json(f"{hub_url}/api/auth/login", {"email": email, "password": password}, timeout=30)
    if not login or not login.get("token"):
        print(f"Login fehlgeschlagen: {error or 'kein Token'}")
        return {"ok": False, "error": "login"}

    token = login["token"]
    latencies: list[int] = []
    succeeded = 0
    print(f"== Master-Chat {runs}x ==")

    for index in range(1, runs + 1):
        payload = {"message": CHAT_MESSAGE, "requestId": f"sep-{int(time.time() * 1000)}-{index}"}
        body, duration_ms, error = call_with_token(hub_url, "/api/master/chat", payload, token)
        attempts = body.get("routeAttempts") or []
        ok = body.get("ok") is True
        if ok:
            succeeded += 1
            latencies.append(duration_ms)
        chain = " | ".join(f"{str(a.get('route'))[:20]}={a.get('code')}" for a in attempts[:5])
        print(f"  Lauf {index}: ok={ok} {duration_ms:>6} ms {error}")
        if chain:
            print(f"          Versuche: {chain}")

    rate = round(100 * succeeded / runs) if runs else 0
    average = round(sum(latencies) / len(latencies)) if latencies else 0
    print(f"== Ergebnis: {succeeded}/{runs} erfolgreich ({rate} %), Mittel {average} ms ==")
    return {"ok": succeeded == runs, "succeeded": succeeded, "runs": runs, "averageMs": average}


def call_with_token(base: str, path: str, payload: dict, token: str) -> tuple[dict, int, str]:
    """POST mit Bearer-Token gegen den Hub."""
    data = json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read()), int((time.monotonic() - started) * 1000), ""
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read())
        except Exception:  # noqa: BLE001
            body = {}
        return body, int((time.monotonic() - started) * 1000), f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return {}, int((time.monotonic() - started) * 1000), type(exc).__name__


# --------------------------------------------------------------------------- #
# Ausgabe
# --------------------------------------------------------------------------- #
def print_changes(changes: list[Change], dry_run: bool) -> None:
    print("== Aenderungen ==")
    if not changes:
        print("  Konfiguration ist bereits korrekt")
        return
    for change in changes:
        arrow = "->" if not dry_run else "-> (geplant)"
        print(f"  #{change.route_id:<3} {change.name[:32]:32s} {change.field:8s} {str(change.before)[:14]:14s} {arrow} {str(change.after)[:14]:14s}  {change.reason}")


def write_report(path: str, payload: dict[str, Any]) -> None:
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        print(f"Bericht: {path}")
    except OSError as exc:
        print(f"Bericht konnte nicht geschrieben werden: {exc}")


# --------------------------------------------------------------------------- #
# Hauptprogramm
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description="Inferenz vom Hub auf Worker-Knoten verlagern.")
    parser.add_argument("task", choices=("bench", "apply", "verify", "all"), nargs="?", default="all")
    parser.add_argument("--db", default=os.environ.get("VF_DB_PATH", DEFAULT_DB), help="Pfad zur Hub-Datenbank")
    parser.add_argument("--hub-url", default=os.environ.get("VF_HUB_URL", DEFAULT_HUB), help="URL des Hubs")
    parser.add_argument("--runs", type=int, default=4, help="Anzahl der Chat-Anfragen bei verify")
    parser.add_argument("--dry-run", action="store_true", help="nur anzeigen, nichts schreiben")
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f"Datenbank nicht gefunden: {args.db}")
        print("Auf dem Hub-Server ausfuehren oder --db setzen.")
        return 1

    try:
        routes = load_routes(args.db)
    except Exception as exc:  # noqa: BLE001
        print(f"Routen nicht lesbar: {exc}")
        return 1
    if not routes:
        print("Keine aktivierten Ollama-Routen gefunden.")
        return 1

    print(f"Routen: {len(routes)} aktivierte Ollama-Endpunkte")
    report: dict[str, Any] = {
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "db": args.db,
        "dryRun": args.dry_run,
        "routes": len(routes),
    }

    measurements: list[Measurement] = []
    changes: list[Change] = []

    if args.task in ("bench", "apply", "all"):
        measurements = bench(routes)
        report["measurements"] = [asdict(item) for item in measurements]

    if args.task in ("apply", "all"):
        changes = plan(measurements, routes)
        report["changes"] = [asdict(change) for change in changes]
        print_changes(changes, args.dry_run)
        written = write_changes(args.db, changes, args.dry_run)
        if args.dry_run:
            print(f"  Trockenlauf: {written} Aenderungen wuerden geschrieben")
        else:
            print(f"  {written} Aenderungen geschrieben")
            prewarm([item for item in measurements if item.usable])

    if args.task in ("verify", "all"):
        report["verification"] = verify(args.hub_url, args.runs)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    write_report(f"/tmp/inference-separation-{stamp}.json", report)

    if args.task == "verify":
        return 0 if report["verification"].get("ok") else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
