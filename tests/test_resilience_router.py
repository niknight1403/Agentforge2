"""
Selbsttest für den ResilienceRouter — ohne Netzwerkzugriff.
Ausführen: python3 tests/test_resilience_router.py
"""
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from resilience import AllProvidersFailed, build_router  # noqa: E402
from resilience.router import NETWORK, QUOTA, RATE_LIMIT  # noqa: E402

ENV = {
    "GEMINI_API_KEY": "g-key",
    "GROQ_API_KEY": "q-key",
    "OPENROUTER_API_KEY": "or-key",
}


def ok_body(text="hallo"):
    return json.dumps({"choices": [{"message": {"content": text}}]})


class FakeTransport:
    """Liefert Antworten je Endpunkt in Reihenfolge; protokolliert Aufrufe."""

    def __init__(self, script):
        self.script = {k: list(v) for k, v in script.items()}
        self.calls = []

    async def __call__(self, url, payload, key, timeout):
        self.calls.append(url)
        for base, answers in self.script.items():
            if base in url:
                if not answers:
                    return answers_fallback(url)
                item = answers.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item
        return 500, "no route"


def answers_fallback(url):
    return 500, "script leer"


def router_with(script, cfg=None, clock=None):
    transport = FakeTransport(script)
    r = build_router(cfg, env=ENV, transport=transport)
    if clock is not None:
        r._clock = clock
    return r, transport


def test_erster_provider_gewinnt():
    r, t = router_with({"generativelanguage": [(200, ok_body("gemini!")), ]})
    res = asyncio.run(r.complete([{"role": "user", "content": "hi"}]))
    assert res["provider"] == "gemini-free", res
    assert res["text"] == "gemini!"
    assert len(t.calls) == 1
    assert any(e["kind"] == "ok" for e in r.events)
    print("ok 1 - erster Provider gewinnt, Latenz + Event protokolliert")


def test_429_failover_mit_cooldown():
    r, t = router_with({
        "generativelanguage": [(429, "rate limit exceeded")],
        "api.groq.com": [(200, ok_body("groq!"))],
    })
    res = asyncio.run(r.complete([{"role": "user", "content": "hi"}]))
    assert res["provider"] == "groq-free", res
    assert res["attempts"][0]["outcome"] == RATE_LIMIT
    assert res["attempts"][0]["cooldown_s"] == 90  # Gemini-spezifischer Cooldown
    status = r.status()
    gem = next(p for p in status["providers"] if p["name"] == "gemini-free")
    assert gem["cooldown_remaining_s"] > 0, gem
    switches = [e for e in r.events if e["kind"] == "switch"]
    assert switches and switches[0]["to"] == "groq-free", switches
    print("ok 2 - 429 setzt Cooldown und schaltet nahtlos zu Groq")


def test_quota_und_5xx_kette():
    r, t = router_with({
        "generativelanguage": [(429, "You exceeded your current quota")],
        "api.groq.com": [(503, "overloaded")],
        "openrouter": [(200, ok_body("or!"))],
    })
    res = asyncio.run(r.complete([{"role": "user", "content": "hi"}]))
    assert res["provider"] == "openrouter-free", res
    outcomes = [a["outcome"] for a in res["attempts"]]
    assert outcomes[0] == QUOTA, outcomes
    assert outcomes[1] == "SERVER_ERROR", outcomes
    print("ok 3 - Quota und 5xx fuehren ueber die Kette zu OpenRouter")


def test_alle_extern_belegt_nutzt_ollama():
    r, t = router_with({
        "generativelanguage": [(429, "rate limited")],
        "api.groq.com": [(429, "rate limited")],
        "openrouter": [(503, "down")],
        "11434": [(200, ok_body("ollama!"))],
    })
    res = asyncio.run(r.complete([{"role": "user", "content": "hi"}]))
    assert res["provider"] == "ollama-local", res
    assert res["text"] == "ollama!"
    assert any(e["kind"] == "switch" and e["to"] == "ollama-local" for e in r.events)
    print("ok 4 - alle externen gesperrt => automatischer Ollama-Fallback")


def test_netzwerkfehler_zaehlt_als_ausfall():
    r, t = router_with({
        "generativelanguage": [asyncio.TimeoutError("timeout")],
        "api.groq.com": [(200, ok_body("groq!"))],
    })
    res = asyncio.run(r.complete([{"role": "user", "content": "hi"}]))
    assert res["attempts"][0]["outcome"] == NETWORK, res["attempts"]
    assert res["provider"] == "groq-free"
    print("ok 5 - Timeout wird als Netzwerkausfall behandelt")


def test_alles_down_wirft_sammelfehler():
    r, t = router_with({
        "generativelanguage": [(500, "err")],
        "api.groq.com": [(500, "err")],
        "openrouter": [(500, "err")],
        "11434": [(500, "err")],
    })
    try:
        asyncio.run(r.complete([{"role": "user", "content": "hi"}]))
    except AllProvidersFailed as exc:
        assert len(exc.attempts) == 4, exc.attempts
        print("ok 6 - Totalausfall liefert AllProvidersFailed mit 4 Versuchen")
        return
    raise AssertionError("AllProvidersFailed erwartet")


def test_cooldown_laeuft_ab():
    jetzt = [1000.0]
    r, t = router_with({
        "generativelanguage": [(429, "rate limited"), (200, ok_body("wieder da"))],
        "api.groq.com": [(200, ok_body("groq"))],
    }, clock=lambda: jetzt[0])
    asyncio.run(r.complete([{"role": "user", "content": "a"}]))
    gem = next(p for p in r.status()["providers"] if p["name"] == "gemini-free")
    assert gem["cooldown_remaining_s"] == 90, gem
    jetzt[0] += 91  # Cooldown abgelaufen
    gem = next(p for p in r.status()["providers"] if p["name"] == "gemini-free")
    assert gem["cooldown_remaining_s"] == 0, gem
    res = asyncio.run(r.complete([{"role": "user", "content": "b"}]))
    assert res["provider"] == "gemini-free", res
    print("ok 7 - Cooldown laeuft nach Ablauf automatisch aus")


def test_fehlender_key_wird_uebersprungen():
    cfg = None
    r, t = router_with({"api.groq.com": [(200, ok_body("groq"))], }, cfg=cfg)
    # Gemini-Key entfernen
    r.env = {"GROQ_API_KEY": "q-key", "OPENROUTER_API_KEY": "or-key"}
    res = asyncio.run(r.complete([{"role": "user", "content": "hi"}]))
    assert res["provider"] == "groq-free", res
    gem = next(p for p in r.status()["providers"] if p["name"] == "gemini-free")
    assert gem["configured"] is False
    print("ok 8 - Provider ohne Key wird uebersprungen, kein Abbruch")


def test_latenz_statistik():
    r, t = router_with({"generativelanguage": [(200, ok_body("x")), (200, ok_body("y"))]})
    asyncio.run(r.complete([{"role": "user", "content": "1"}]))
    asyncio.run(r.complete([{"role": "user", "content": "2"}]))
    lat = r.status()["providers"][0]["latency"]
    assert lat["count"] == 2 and lat["ok"] == 2, lat
    assert lat["avg_ms"] is not None and lat["min_ms"] <= lat["max_ms"], lat
    print("ok 9 - Latenz-Tracking sammelt avg/min/max korrekt")


ALL = [
    test_erster_provider_gewinnt,
    test_429_failover_mit_cooldown,
    test_quota_und_5xx_kette,
    test_alle_extern_belegt_nutzt_ollama,
    test_netzwerkfehler_zaehlt_als_ausfall,
    test_alles_down_wirft_sammelfehler,
    test_cooldown_laeuft_ab,
    test_fehlender_key_wird_uebersprungen,
    test_latenz_statistik,
]

if __name__ == "__main__":
    fails = 0
    for fn in ALL:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            fails += 1
            print(f"NOT OK {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n# tests {len(ALL)} | pass {len(ALL) - fails} | fail {fails}")
    sys.exit(1 if fails else 0)
