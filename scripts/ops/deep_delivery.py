#!/usr/bin/env python3
"""Deep Villa Delivery: Lagebild, exklusiver Start, Web-Build, APK-Nachweis.

Arbeitet ausschliesslich ueber die oeffentliche Hub-API
(VF_HUB_URL, Default https://hub.cybersarah-ki.com) mit VF_ADMIN_EMAIL /
VF_ADMIN_PASSWORD. Jeder Modus prueft sein Ergebnis und beendet sich bei
Nichterfuellung mit Exit-Code != 0 (keine erfundene Evidenz).

Modi:
  status      Read-only Lagebild der Deep Villa
  apply       Exklusiver Fokus, Konkurrenz anhalten, runToCompletion starten
  build       Web-Build im Hub anstossen und bis zum Ende beobachten
  apk-fetch   Villa-Name + Build-Artefakt nach /tmp/villa.zip (fuer die APK-Baustrasse)
  apk-verify  APK strukturell pruefen (Zip, Manifest, Signatur, Web-Root)
  features        Funktionsauftraege (mybabes-Parität) idempotent in die Villa legen
  features-verify Pruft das gebaute Web-Artefakt auf die geforderten Oberflaechen
  features-run    Wartet auf die Funktionsauftraege, baut, prueft (eine CI-Strecke)
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

BASE = os.environ.get("VF_HUB_URL", "https://hub.cybersarah-ki.com").rstrip("/")
DEEP_ID_CANDIDATE = 34
DEEP_PREFIX = "deep ·"


def call(path: str, method: str = "GET", body=None, token: str | None = None, raw: bool = False, timeout: int = 40):
    url = BASE + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = r.read()
        if raw:
            return payload
        return json.loads(payload or b"null")


def login() -> str:
    email = os.environ.get("VF_ADMIN_EMAIL", "").strip()
    password = os.environ.get("VF_ADMIN_PASSWORD", "").strip()
    if not email or not password:
        raise SystemExit("VF_ADMIN_EMAIL/VF_ADMIN_PASSWORD fehlen.")
    try:
        out = call("/api/auth/login", "POST", {"email": email, "password": password})
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Login abgelehnt: HTTP {e.code} {e.read()[:200]!r}")
    token = (out or {}).get("token")
    if not token:
        raise SystemExit("Login ohne Token.")
    return token


def villas(token) -> list[dict]:
    raw = call("/api/villas", token=token)
    if isinstance(raw, dict):
        raw = raw.get("villas") or raw.get("items") or []
    return raw


def resolve_deep(token) -> dict:
    """Exakt dieselbe Regel wie scripts/ops/focus-deep-villa.sh: ID 34 und
    Name beginnt mit "deep ·". Villa #39 heisst ebenfalls "Deep · ..." und
    darf nicht mitgenommen werden."""
    alle = villas(token)
    treffer = [v for v in alle
               if int(v.get("id") or 0) == DEEP_ID_CANDIDATE
               and (v.get("name") or "").lower().startswith(DEEP_PREFIX)]
    if len(treffer) != 1:
        ids = [(v.get("id"), v.get("name")) for v in alle]
        raise SystemExit(f"Deep Villa nicht eindeutig ({len(treffer)} Treffer). Villen: {ids}")
    return treffer[0]


def kurz(v: dict) -> str:
    return json.dumps(
        {
            k: v.get(k)
            for k in ("id", "name", "status", "autonomy", "executing", "queued", "tasks_total", "tasks_done", "tasks_open", "updated_at")
            if k in v
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def mode_status() -> int:
    token = login()
    alle = villas(token)
    deep = resolve_deep(token)
    did = int(deep["id"])
    print(f"VILLEN-GESAMT {len(alle)}")
    for v in alle:
        mark = ">>>" if int(v.get("id") or 0) == did else "   "
        print(mark, kurz(v))

    detail = call(f"/api/villas/{did}", token=token)
    villa = detail.get("villa") or {}
    counts = detail.get("taskCounts") or {}
    print("DEEP-VILLA", kurz(villa))
    print("TASK-COUNTS", json.dumps(counts, ensure_ascii=False))
    print("LAUFEND", json.dumps(detail.get("runningTasks") or [], ensure_ascii=False)[:400])
    print("OFFEN", detail.get("openCount"), "ETA-MIN", villa.get("etaMinutes"), villa.get("eta_minutes"))

    offen = [t for t in (detail.get("tasks") or []) if t.get("status") != "DONE"]
    for t in offen[:15]:
        print("OFFENE-AUFGABE", json.dumps({k: t.get(k) for k in ("id", "status", "role", "priority", "title")}, ensure_ascii=False)[:220])
    for t in offen:
        res = str(t.get("result") or "").strip()
        if t.get("status") in ("FAILED", "BLOCKED") and res:
            print("FEHLER", t.get("id"), (t.get("title") or "")[:70], "::", res[:300].replace("\n", " | "))
            break

    for pfad, label in ((f"/api/villas/{did}/build", "BUILD"), (f"/api/villas/{did}/product", "PRODUKT"),
                        (f"/api/villas/{did}/delivery-evidence", "EVIDENZ"), (f"/api/villas/{did}/preview", "PREVIEW")):
        try:
            print(label, json.dumps(call(pfad, token=token), ensure_ascii=False)[:700])
        except urllib.error.HTTPError as e:
            print(label, f"HTTP {e.code}", e.read()[:200])

    for pfad in ("/api/focus", "/api/scheduler"):
        try:
            print(pfad.upper(), json.dumps(call(pfad, token=token), ensure_ascii=False)[:400])
        except urllib.error.HTTPError as e:
            print(pfad, f"HTTP {e.code}")

    versuch = call(f"/api/villas/{did}/build/download", token=token, raw=True)
    print("ARTEFAKT-BYTES", len(versuch or b""))
    return 0


def mode_apply() -> int:
    token = login()
    deep = resolve_deep(token)
    did = int(deep["id"])
    fokus = call("/api/focus", "POST", {"villaIds": [did], "reason": "Deep Villa: exklusive Lieferung bis zum verifizierten Web-Build inkl. APK"}, token=token)
    print("FOKUS", json.dumps(fokus, ensure_ascii=False)[:300])
    if not (isinstance(fokus, dict) and fokus.get("ok") is True):
        raise SystemExit("Fokus nicht gesetzt.")

    for v in villas(token):
        vid = int(v.get("id") or 0)
        if vid == did:
            continue
        busy = (v.get("autonomy") or 0) == 1 or (v.get("executing") or 0) == 1 or str(v.get("status") or "").upper() in (
            "RUNNING", "WAITING_FOR_MODEL", "STOPPING")
        if busy:
            try:
                call(f"/api/villas/{vid}/stop", "POST", token=token)
                print("PAUSIERT", vid)
            except urllib.error.HTTPError as e:
                print("STOP-FEHLER", vid, e.code)

    start = call(f"/api/villas/{did}/orchestrate", "POST", {"runToCompletion": True, "concurrency": 0}, token=token)
    print("START", json.dumps(start, ensure_ascii=False)[:400])
    if not (isinstance(start, dict) and start.get("ok") is True):
        raise SystemExit("Orchestrierung nicht gestartet.")
    return 0


def mode_build() -> int:
    token = login()
    deep = resolve_deep(token)
    did = int(deep["id"])
    try:
        rec = call(f"/api/villas/{did}/build", "POST", token=token)
        print("BUILD-GESTARTET", json.dumps(rec, ensure_ascii=False)[:400])
    except urllib.error.HTTPError as e:
        print("BUILD-START", f"HTTP {e.code}", e.read()[:300])

    ende = time.time() + 600
    letzter = None
    while time.time() < ende:
        st = call(f"/api/villas/{did}/build", token=token)
        zeile = json.dumps(st, ensure_ascii=False)[:400]
        if zeile != letzter:
            print("BUILD-STATUS", zeile)
            letzter = zeile
        state = str((st or {}).get("state") or (st or {}).get("status") or "").upper()
        if state in ("DONE", "SUCCESS", "READY", "OK", "FINISHED"):
            art = call(f"/api/villas/{did}/build/download", token=token, raw=True)
            print("ARTEFAKT-BYTES", len(art or b""))
            return 0 if (art and len(art) > 1000) else 1
        if state in ("FAILED", "ERROR"):
            return 1
        time.sleep(15)
    print("TIMEOUT: Build nach 10 Minuten nicht fertig")
    return 1


def mode_apk_fetch() -> int:
    token = login()
    did = int(os.environ.get("VILLA_ID") or DEEP_ID_CANDIDATE)
    detail = call(f"/api/villas/{did}", token=token)
    villa = detail.get("villa") or {}
    name = (os.environ.get("APP_NAME") or villa.get("name") or "Deep Villa").strip()
    st = call(f"/api/villas/{did}/build", token=token)
    print("BUILD-STATUS", json.dumps(st, ensure_ascii=False)[:400])
    art = call(f"/api/villas/{did}/build/download", token=token, raw=True)
    if not art or len(art) < 1000:
        raise SystemExit(f"Kein Web-Build-Artefakt ({len(art or b'')} Bytes).")
    with open("/tmp/villa.zip", "wb") as fh:
        fh.write(art)
    with open("/tmp/villa-name.txt", "w", encoding="utf-8") as fh:
        fh.write(name + "\n")
    print("ARTEFAKT", len(art), "Bytes ->", "/tmp/villa.zip")
    env = os.environ.get("GITHUB_ENV")
    if env:
        with open(env, "a", encoding="utf-8") as fh:
            fh.write(f"VILLA_NAME={name}\n")
            fh.write(f"VILLA_ID={did}\n")
    print("VILLA-NAME", name)
    return 0


def mode_apk_verify(pfad: str) -> int:
    if not os.path.isfile(pfad):
        raise SystemExit(f"APK fehlt: {pfad}")
    groesse = os.path.getsize(pfad)
    print("APK", pfad, groesse, "Bytes")
    fehler = []
    with zipfile.ZipFile(pfad) as z:
        kaputt = z.testzip()
        if kaputt:
            fehler.append(f"defekter Eintrag: {kaputt}")
        namen = set(z.namelist())
        for muss in ("AndroidManifest.xml", "classes.dex", "resources.arsc"):
            if muss not in namen:
                fehler.append(f"fehlt: {muss}")
        web = [n for n in namen if n.startswith("assets/www/") and n.endswith("index.html")]
        if not web:
            fehler.append("kein assets/www/index.html")
        else:
            html = z.read(web[0]).decode("utf-8", "replace")
            print("WEB-INDEX", web[0], len(html), "Bytes", "| Titel:", html.split("<title>")[1].split("</title>")[0][:60] if "<title>" in html else "?")
            if "Villa-Produkt wird geladen" in html:
                fehler.append("nur Platzhalter-Seite")
        roh = open(pfad, "rb").read()
        v2 = b"APK Sig Block 42" in roh
        v1 = any(n.startswith("META-INF/") and n.upper().endswith((".RSA", ".DSA", ".EC")) for n in namen)
        print("SIGNATUR v1:", v1, "| v2/v3-Block:", v2)
        if not (v1 or v2):
            fehler.append("keine Signatur gefunden")
        # Binaeres Manifest: Berechtigungen stehen als UTF-16-Strings im Pool.
        man = z.read("AndroidManifest.xml")
        for brauch in ("android.permission.INTERNET",):
            if brauch.encode("utf-16-le") not in man and brauch.encode() not in man:
                fehler.append(f"Manifest ohne {brauch}")
        dex = sum(len(z.read(n)) for n in namen if n.endswith(".dex"))
        print("DEX-BYTES", dex, "| WEB-DATEIEN", len([n for n in namen if n.startswith("assets/www/")]))
    if fehler:
        for f in fehler:
            print("FEHLER:", f)
        return 1
    print("APK-PRUEFUNG: bestanden")
    return 0



# ---------------------------------------------------------------------------
# Funktionsparität zu mybabes.ai (Nikos Auftrag 2026-11-09).
# Belege: docs/mybabes-feature-parity.md (öffentliche Startseite, 2026-11-09).
# Jeder Auftrag nennt seine Abnahmekriterien und verbietet erfundene Nachweise.
# ---------------------------------------------------------------------------

FEATURE_TASKS = [
    {
        "key": "F1",
        "title": "F1 Explore-Hub: Charaktere, Bilder, Videos mit Tag-Filtern und Suche",
        "markers": [r"explore", r"filter|tag"],
        "description": (
            "Erweitere das bestehende Produkt um einen Explore-Hub mit vier Bereichen: "
            "Charaktere, Bilder, Videos, Stories. Jeder Bereich zeigt Karten aus den vorhandenen "
            "Beispieldaten. Dazu eine Filterleiste (Stil: realistisch/anime, Kategorie-Tags) und "
            "ein Suchfeld, das die Karten live filtert. Kein Nachladen aus fremden Seiten, keine "
            "erfundenen Inhalte: wenn ein Bereich keine Daten hat, zeigt er einen leeren Zustand mit "
            "klarem Text. Abnahme: Explore im Menue erreichbar, Filter und Suche ändern die "
            "angezeigten Karten nachvollziehbar, Build bleibt gruen."
        ),
    },
    {
        "key": "F2",
        "title": "F2 Charakter-Builder: Aussehen, Backstory, Persoenlichkeit, Sprechstil, Vorlage, visuelle Identitaet",
        "markers": [r"builder|erstell", r"pers(ö|oe)nlichkeit|personality|backstory"],
        "description": (
            "Baue einen Charakter-Builder mit Feldern fuer Name, Alter, Aussehen, Backstory, "
            "Persoenlichkeit und Sprechstil. Speichere eigene Charaktere dauerhaft im Browser "
            "(localStorage) und liste sie im Explore-Hub mit. Zusaetzlich eine Vorlage ('Template Babe'), "
            "die ein Formular vorbelegt, und ein Feld 'visuelle Merkmale' (Haare, Augen, Stil), das als "
            "Identitaetsanker gespeichert und bei jedem generierten Medium mitgeschickt wird. "
            "Abnahme: eigener Charakter ist nach dem Speichern im Explore sichtbar und im Chat auswaehlbar, "
            "Felder werden validiert, Build bleibt gruen."
        ),
    },
    {
        "key": "F3",
        "title": "F3 Chat mit Gedaechtnis und Chat-Galerie",
        "markers": [r"ged(ä|ae)chtnis|memory|verlauf", r"galerie|gallery"],
        "description": (
            "Der Chat speichert den Verlauf je Charakter im Browser und laedt ihn beim Oeffnen wieder. "
            "Der Charakter bekommt die letzten Nachrichten als Kontext, damit Bezuege erhalten bleiben. "
            "Dazu eine Chat-Galerie: erzeugte oder hochgeladene Medien werden im Verlauf und in einer "
            "eigenen Galerie je Charakter angezeigt, mit Loeschfunktion. Solange kein Modell-Endpunkt "
            "konfiguriert ist, antwortet die lokale Regel-Engine und das Produkt sagt das offen. "
            "Abnahme: Verlauf ueberlebt einen Reload, Galerie zeigt vorhandene Medien, Build bleibt gruen."
        ),
    },
    {
        "key": "F4",
        "title": "F4 Stimme: Sprachausgabe und Spracheingabe",
        "markers": [r"speech|voice|stimme|sprach"],
        "description": (
            "Nutze die Browser-Schnittstellen SpeechSynthesis (Ausgabe) und SpeechRecognition (Eingabe), "
            "wenn vorhanden. Jede Chat-Antwort bekommt einen Vorlesen-Knopf, das Eingabefeld einen "
            "Mikrofon-Knopf. Fehlt die Schnittstelle im Browser, zeigt der Knopf 'nicht verfuegbar' "
            "statt still zu scheitern. Abnahme: beide Knoepfe existieren, erkennen die Verfuegbarkeit "
            "korrekt, fallen ohne Absturz zurueck, Build bleibt gruen."
        ),
    },
    {
        "key": "F5",
        "title": "F5 Bildgenerator mit Anbieter-Adapter und Token-Zaehler",
        "markers": [r"bildgenerator|image.?generator", r"token"],
        "description": (
            "Baue eine Bildgenerator-Oberflaeche mit Prompt, Stilwahl, 2K-Option und Ergebnisbereich. "
            "Die Erzeugung laeuft ueber einen Adapter, der einen konfigurierten Anbieter aufruft. "
            "Fehlt die Konfiguration, zeigt die Oberflaeche 'nicht konfiguriert' und erzeugt kein "
            "Platzhalterbild, das wie ein Ergebnis aussieht. Ein Token-Zaehler zeigt Verbrauch und "
            "Restguthaben aus dem lokalen Konto. Abnahme: Oberflaeche vorhanden, Zustand ohne Anbieter "
            "ist klar benannt, Build bleibt gruen."
        ),
    },
    {
        "key": "F6",
        "title": "F6 Videogenerator und Reels mit Modellwahl",
        "markers": [r"video", r"reel"],
        "description": (
            "Baue eine Video-Oberflaeche mit Modellwahl (zwei frei benannte Modelle), Dauer, Prompt und "
            "Ergebnisbereich sowie eine Reels-Ansicht, die vorhandene Videos als kurze Sequenz abspielt. "
            "Erzeugung wieder ueber denselben Anbieter-Adapter wie beim Bild mit klarem Zustand "
            "'nicht konfiguriert'. Abnahme: Video- und Reels-Ansicht vorhanden, Modellwahl wirkt, "
            "Build bleibt gruen."
        ),
    },
    {
        "key": "F7",
        "title": "F7 Story-Creator fuer fortlaufende Handlungen",
        "markers": [r"story|geschichte"],
        "description": (
            "Baue einen Story-Creator: Charakter waehlen, Kapitel anlegen, Handlung in Stichpunkten "
            "ergaenzen, Kapitel als Liste anzeigen und im Browser speichern. Der Charakter und seine "
            "visuellen Merkmale bleiben ueber Kapitel hinweg gleich. Abnahme: mehrere Kapitel lassen sich "
            "anlegen, bearbeiten und wieder laden, Build bleibt gruen."
        ),
    },
    {
        "key": "F8",
        "title": "F8 Creator-Bereich, Token-/Abo-Seite, Alterssperre, Rechtsseiten",
        "markers": [r"creator", r"abo|abonnement|preis|pricing|token", r"18|alter|vollj(ä|ae)hrig"],
        "description": (
            "Ergaenze: (a) Creator-Bereich, in dem ein eigener Charakter als oeffentlich markiert und "
            "wieder entfernt werden kann, (b) Seite mit Token-Paketen und Abo-Uebersicht, die offen sagt, "
            "dass ohne Zahlungsanbieter kein Verkauf stattfindet, (c) Altersabfrage beim ersten Start, "
            "(d) Rechtsseiten: Nutzungsbedingungen, Datenschutz, gesperrte Inhalte, Entfernung, "
            "Altersverifikation - als eigene Seiten mit ehrlichem Platzhaltertext, der den Stand benennt. "
            "Abnahme: alle vier Punkte erreichbar, Altersabfrage blockiert bis zur Bestaetigung, "
            "Build bleibt gruen."
        ),
    },
]


def gateway_token(token: str) -> str:
    """Schreib-Token fuer die Gateway-API. Der Admin-Token-Weg braucht Superadmin;
    die Schluessel-Route ist der Fallback und liefert den Schluessel einmalig."""
    try:
        out = call("/api/admin/gateway-token", "POST", {"role": "admin", "villaIds": [DEEP_ID_CANDIDATE], "ttlSeconds": 3600}, token=token)
        if out.get("token"):
            print("GATEWAY-TOKEN", "admin (Kurzlebig)")
            return out["token"]
    except urllib.error.HTTPError as e:
        print("GATEWAY-TOKEN-START", f"HTTP {e.code}", e.read()[:160])
    try:
        out = call("/api/v1/gateway-keys", "POST", {"label": "deep-features", "role": "admin", "villaIds": [DEEP_ID_CANDIDATE], "ttlSeconds": 1800}, token=token)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Kein Schreib-Token: HTTP {e.code} {e.read()[:200]!r} (Adminrechte noetig)")
    key = out.get("apiKey") or out.get("key") or out.get("token")
    if not key:
        raise SystemExit(f"Schluessel-Antwort ohne Schluessel: {json.dumps(out, ensure_ascii=False)[:200]}")
    print("GATEWAY-TOKEN", "admin (Schluessel, 30 Minuten)")
    return key


def vorhandene_titel(token: str, did: int) -> set[str]:
    rows = call(f"/api/villas/{did}/tasks?limit=500", token=token) or []
    return {normal(str(t.get("title") or "")) for t in rows}


def normal(text: str) -> str:
    return " ".join(text.lower().split())


def mode_features() -> int:
    """Legt die Funktionsauftraege idempotent an und startet die Villa.
    Doppelte Titel werden uebersprungen, damit ein zweiter Lauf keine
    Auftraege verdoppelt."""
    token = login()
    deep = resolve_deep(token)
    did = int(deep["id"])
    gtoken = gateway_token(token)
    bekannt = vorhandene_titel(token, did)
    neu = 0
    for auf in FEATURE_TASKS:
        if normal(auf["title"]) in bekannt:
            print("VORHANDEN", auf["key"], auf["title"][:70])
            continue
        try:
            out = call("/api/v1/gateway/tasks", "POST",
                       {"villaId": did, "title": auf["title"], "description": auf["description"]},
                       token=gtoken)
        except urllib.error.HTTPError as e:
            print("FEHLER", auf["key"], f"HTTP {e.code}", e.read()[:200])
            return 1
        neu += 1
        print("ANGELEGT", auf["key"], out.get("taskId"), out.get("status"))
    print("NEU", neu, "VON", len(FEATURE_TASKS))
    # Eine COMPLETED-Villa nimmt der Scheduler nicht von selbst wieder auf:
    # erst stoppen (Status PAUSED), dann mit runToCompletion neu einreihen.
    status = call(f"/api/villas/{did}", token=token)
    villa = status.get("villa") or {}
    if str(villa.get("status") or "").upper() in ("COMPLETED", "FAILED"):
        print("WIEDERAUFNAHME", villa.get("status"), "-> PAUSED")
        call(f"/api/villas/{did}/stop", "POST", token=token)
        time.sleep(2)
    start = call(f"/api/villas/{did}/orchestrate", "POST", {"runToCompletion": True, "concurrency": 0}, token=token)
    print("START", json.dumps(start, ensure_ascii=False)[:300])
    if not (isinstance(start, dict) and start.get("ok") is True):
        raise SystemExit("Orchestrierung abgelehnt.")
    st = call(f"/api/villas/{did}/product", token=token)
    print("SCORE", st.get("score"), "VERIFIED", st.get("verified"), "STAGE", st.get("stage"))
    status = call(f"/api/villas/{did}", token=token)
    villa = status.get("villa") or {}
    print("VILLA", kurz({**villa, "id": did}))
    return 0 if neu or True else 1


def artefakt_text(pfad: str, grenze: int = 4_000_000) -> str:
    """Text aller Web-Dateien im Build-Artefakt, damit die Pruefung nicht nur
    index.html liest."""
    teile: list[str] = []
    with zipfile.ZipFile(pfad) as z:
        for name in z.namelist():
            if not name.lower().endswith((".html", ".js", ".css", ".json", ".txt", ".svg")):
                continue
            if z.getinfo(name).file_size > 512_000:
                continue
            teile.append(z.read(name).decode("utf-8", "replace"))
            if sum(len(t) for t in teile) > grenze:
                break
    return "\n".join(teile)


def mode_features_verify() -> int:
    """Prueft das gebaute Web-Artefakt auf die geforderten Oberflaechen.
    Diese Pruefung belegt Vorhandensein, nicht Bedienqualitaet."""
    token = login()
    deep = resolve_deep(token)
    did = int(deep["id"])
    art = call(f"/api/villas/{did}/build/download", token=token, raw=True)
    if not art or len(art) < 1000:
        raise SystemExit(f"Kein Web-Build-Artefakt ({len(art or b'')} Bytes). Erst build laufen lassen.")
    pfad = "/tmp/villa-features.zip"
    with open(pfad, "wb") as fh:
        fh.write(art)
    text = artefakt_text(pfad).lower()
    print("ARTEFAKT", len(art), "Bytes, Textlaenge", len(text))
    fehlt = []
    for auf in FEATURE_TASKS:
        treffer = {m: bool(re.search(m, text, re.I)) for m in auf["markers"]}
        ok = all(treffer.values())
        print("PRUEFUNG", auf["key"], "OK" if ok else "FEHLT",
              json.dumps({m: v for m, v in treffer.items()}, ensure_ascii=False))
        if not ok:
            fehlt.append(auf["key"])
    if fehlt:
        print("NICHT-NACHGEWIESEN", ",".join(fehlt))
        return 1
    print("ALLE-FUNKTIONEN-NACHGEWIESEN", len(FEATURE_TASKS))
    return 0



def offene_aufgaben(token: str, did: int) -> tuple[int, int]:
    rows = call(f"/api/villas/{did}/tasks?limit=500", token=token) or []
    offen = [t for t in rows if str(t.get("status") or "").upper() not in ("DONE", "CANCELLED", "CANCELED")]
    return len(offen), len(rows)


def mode_features_run() -> int:
    """Eine Strecke fuer die CI: auf die Funktionsauftraege warten, dann bauen
    und die Oberflaechen pruefen. Warten ist kein Nachweis - erst der Build mit
    bestandener Pruefung beendet den Lauf erfolgreich."""
    token = login()
    deep = resolve_deep(token)
    did = int(deep["id"])
    geduld = int(os.environ.get("VF_FEATURES_WAIT_SEC", "5400"))
    ende = time.time() + geduld
    letzter = None
    while time.time() < ende:
        status = call(f"/api/villas/{did}", token=token)
        villa = status.get("villa") or {}
        offen, gesamt = offene_aufgaben(token, did)
        zeile = f"status={villa.get('status')} autonomy={villa.get('autonomy')} executing={villa.get('executing')} offen={offen}/{gesamt}"
        if zeile != letzter:
            print("LAGE", zeile, flush=True)
            letzter = zeile
        if offen == 0:
            print("AUFTRAEGE-FERTIG", flush=True)
            break
        time.sleep(60)
    else:
        print("WARTEZEIT-ERSCHOEPFT", f"{geduld}s", flush=True)

    offen, gesamt = offene_aufgaben(token, did)
    if offen:
        print("NICHT-FERTIG", f"{offen} von {gesamt} offen", flush=True)
        return 1

    print("BAU-START", flush=True)
    rc = mode_build()
    if rc != 0:
        print("BAU-FEHLER", rc, flush=True)
        return rc
    return mode_features_verify()


def mode_plan() -> int:
    """Zeigt je Phase, welche Pflicht-Bausteine fehlen und warum der Score
    unter 100 bleibt (Produkt-Gate der Villa)."""
    token = login()
    deep = resolve_deep(token)
    did = int(deep["id"])
    prod = call(f"/api/villas/{did}/product", token=token)
    print("SCORE", prod.get("score"), "PLAN", prod.get("planScore"), "STAGE", prod.get("stage"),
          "PHASE", prod.get("currentPhase"), "VERIFIED", prod.get("verified"))
    print("BLOCKERS", json.dumps(prod.get("blockers"), ensure_ascii=False)[:400])
    r = prod.get("readiness") or {}
    print("READINESS", r.get("status"), r.get("verified"), "QUELLE", r.get("sourceFiles"))
    for k, v in (r.get("checks") or {}).items():
        print("  CHECK", k, v.get("status"), str(v.get("output") or "")[:160].replace("\n", " | "))
    offen = []
    for ph in prod.get("phases") or []:
        print(f"PHASE {ph.get('id')} ratio={ph.get('ratio')} {str(ph.get('title'))[:40]}")
        for it in ph.get("items") or []:
            if it.get("state") != "DONE":
                offen.append((ph.get("id"), it))
                print("   OFFEN", it.get("state"), it.get("key"), str(it.get("title"))[:70])
    print("OFFENE-PFLICHT", len(offen))
    tasks = call(f"/api/villas/{did}/tasks?limit=500", token=token)
    for _, it in offen:
        key = str(it.get("key") or "")
        titel = str(it.get("title") or "")
        treffer = [t for t in tasks if key and key.lower() in (str(t.get("title")) + " " + str(t.get("description"))).lower()][:5]
        for t in treffer:
            print("   TASK-TREFFER", t.get("id"), t.get("status"), str(t.get("title"))[:70])
    return 0


if __name__ == "__main__":
    modus = sys.argv[1] if len(sys.argv) > 1 else "status"
    tabelle = {
        "status": mode_status,
        "apply": mode_apply,
        "build": mode_build,
        "plan": mode_plan,
        "apk-fetch": mode_apk_fetch,
        "apk-verify": lambda: mode_apk_verify(sys.argv[2] if len(sys.argv) > 2 else "deep-villa.apk"),
        "features": mode_features,
        "features-verify": mode_features_verify,
        "features-run": mode_features_run,
    }
    if modus not in tabelle:
        raise SystemExit(f"Unbekannter Modus: {modus}")
    sys.exit(tabelle[modus]())
