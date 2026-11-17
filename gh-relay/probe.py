import json, os, time, urllib.request, urllib.error, datetime, pathlib

stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
out = pathlib.Path("docs/swarm")
out.mkdir(parents=True, exist_ok=True)

TARGETS = [
    ("cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1/chat/completions", "gpt-oss-120b", 700),
    ("groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1/chat/completions", "llama-3.1-8b-instant", 24),
    ("openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1/chat/completions", "openai/gpt-4o-mini", 24),
]

results = []
for name, env, url, model, max_tokens in TARGETS:
    key = os.environ.get(env, "")
    row = {"provider": name, "model": model, "ok": False}
    if not key:
        row["error"] = "secret missing"
        results.append(row)
        continue
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Antworte mit genau einem Wort: bereit"}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "stream": False,
    }).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
        "User-Agent": "swarm-relay/1.0",
    })
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode())
        text = ""
        if "choices" in data:
            text = (data["choices"][0].get("message") or {}).get("content") or ""
        row["ok"] = bool(text.strip())
        row["latency_ms"] = int((time.time() - started) * 1000)
        row["reply_chars"] = len(text.strip())
    except urllib.error.HTTPError as e:
        row["status"] = e.code
        row["error"] = e.read().decode()[:140]
    except Exception as e:
        row["error"] = str(e)[:140]
    results.append(row)

ok_count = sum(1 for r in results if r["ok"])
pathlib.Path("docs/swarm/providers.json").write_text(
    json.dumps({"ok": ok_count > 0, "checked_at": stamp, "ok_count": ok_count, "providers": results}, indent=2) + "\n"
)
first = next((r for r in results if r["ok"]), results[0])
pathlib.Path("docs/swarm/heartbeat.json").write_text(
    json.dumps({
        "ok": bool(first["ok"]),
        "checked_at": stamp,
        "provider": first["provider"],
        "model": first["model"],
        "latency_ms": first.get("latency_ms"),
        "ok_count": ok_count,
    }, indent=2) + "\n"
)
print(json.dumps({"ok_count": ok_count, "results": [{k: v for k, v in r.items() if k != "error"} for r in results]}))
