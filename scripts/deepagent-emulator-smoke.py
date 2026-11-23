"""Drive the real Android APK against the isolated VillaForge Hub in CI."""
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ARTIFACTS = Path(os.environ.get("E2E_ARTIFACTS", "emulator-evidence"))
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def adb(*args):
    return subprocess.run(["adb", *args], check=True, capture_output=True).stdout


def hierarchy():
    adb("shell", "uiautomator", "dump", "/sdcard/window.xml")
    xml = adb("exec-out", "cat", "/sdcard/window.xml")
    (ARTIFACTS / "last-window.xml").write_bytes(xml)
    return ET.fromstring(xml)


def matches(root, label):
    return [n for n in root.iter() if label in (n.attrib.get("text", ""), n.attrib.get("content-desc", ""))]


def wait(label, timeout=35, scroll=False):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        root = hierarchy()
        nodes = matches(root, label)
        if nodes:
            return nodes[0]
        if scroll:
            adb("shell", "input", "swipe", "250", "780", "250", "300", "350")
        time.sleep(1)
    raise AssertionError(f"Android UI missing {label!r}; hierarchy saved in {ARTIFACTS}")


def tap(label, **kwargs):
    node = wait(label, **kwargs)
    bounds = node.attrib.get("bounds", "")
    coords = [int(x) for x in re.findall(r"\d+", bounds)]
    if len(coords) != 4:
        raise AssertionError(f"No bounds for {label}: {bounds}")
    adb("shell", "input", "tap", str((coords[0] + coords[2]) // 2), str((coords[1] + coords[3]) // 2))
    print(f"TAP {label}", flush=True)


def capture(name):
    (ARTIFACTS / f"{name}.png").write_bytes(adb("exec-out", "screencap", "-p"))


try:
    wait("Übersicht", timeout=45)
    tap("Deep Agent", scroll=True)
    tap("Emulator-Projekt Design 3")
    wait("Chat")
    wait("Vorschau")
    wait("Live-Vorschau · Webansicht verfügbar")
    wait("Build & Downloads")
    capture("01-chat-preview")

    tap("Vorschau")
    wait("LIVE VORSCHAU TEST")
    wait("Statusdetails und Werkzeuge anzeigen")
    # The same fixture must be served by the Hub; the WebView render is captured.
    capture("02-full-preview")
    tap("Statusdetails und Werkzeuge anzeigen")
    wait("Statusdetails schließen")
    wait("Entwicklung fortsetzen")
    capture("03-quality-tools")

    tap("Chat")
    tap("Nachricht an DeepAgent")
    adb("shell", "input", "text", "E2E-Chatcheck-2026")
    capture("04-keyboard")
    print("POST_INPUT_UI", [(n.attrib.get("text"), n.attrib.get("content-desc"), n.attrib.get("bounds")) for n in hierarchy().iter() if n.attrib.get("text") or n.attrib.get("content-desc")], flush=True)
    tap("Nachricht senden")
    wait("CI fixture: Projekt verstanden. Stack und Meilensteine werden in den E2E-Tests separat verifiziert.", timeout=30)
    capture("04-chat-sent")

    # About 314 dp wide on this emulator: exercise the smallest supported phone layout.
    app_pid = adb("shell", "pidof", "dev.villaforge.app").strip()
    adb("shell", "wm", "size", "864x1760")
    wait("Nachricht an DeepAgent")
    capture("05-compact-chat")
    for _ in range(3):
        tap("Vorschau")
        wait("LIVE VORSCHAU TEST")
        tap("Chat")
        wait("Nachricht an DeepAgent")
    if adb("shell", "pidof", "dev.villaforge.app").strip() != app_pid:
        raise AssertionError("Android app restarted during rapid Chat/Vorschau switching")

    tap("Build & Downloads", scroll=True)
    wait("Fertigstellung", timeout=45)
    wait("Produkt-Build (APK / Paket)", timeout=45)
    wait("noch nicht gebaut")
    capture("06-compact-download-status")
    tap("Alternativen und Scout anzeigen", scroll=True)
    wait("Jetzt nach besserer Alternative suchen", scroll=True)
    for _ in range(3):
        adb("shell", "input", "swipe", "250", "350", "250", "1200", "350")
    tap("Alternativen ausblenden")
    tap("Phasenplanung und Evolution anzeigen", scroll=True)
    wait("Villa-Evolution", scroll=True)
    print("ANDROID_DEEPAGENT_E2E_PASSED", flush=True)
except Exception:
    print("FAILURE_UI", [(n.attrib.get("text"), n.attrib.get("content-desc"), n.attrib.get("bounds")) for n in hierarchy().iter() if n.attrib.get("text") or n.attrib.get("content-desc")], flush=True)
    capture("failure")
    raise
finally:
    adb("shell", "wm", "size", "reset")
