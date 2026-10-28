"""
Smart Resilience Router — hochverfügbares LLM-Routing für AgentForge2.

Failover-Kette (Priorität aufsteigend):
  1. Gemini Free  2. Groq Free  3. OpenRouter Free  4. Ollama Local (letzter Ausweg)

Verhalten bei Fehlern:
  - HTTP 429 (Rate Limit) / Quota erschöpft / HTTP 5xx / Netzwerkfehler
    => betroffener Provider bekommt einen Cooldown (konfigurierbar) und der
       Router wechselt sofort und nahtlos zum nächsten Provider.
  - Sind alle externen Provider gesperrt oder ohne Key, wird automatisch der
    lokale Ollama-Endpunkt genutzt (Standard: http://localhost:11434).

Der Router ist transport-agnostisch: Standard ist aiohttp, ohne aiohttp wird
urllib in einem Thread benutzt. Für Tests kann `transport` injiziert werden.

Lizenzfrei, dependency-arm, vollständig async.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Deque, Dict, Iterable, List, Optional

log = logging.getLogger("agentforge2.resilience")

RATE_LIMIT = "RATE_LIMIT"
QUOTA = "QUOTA"
SERVER_ERROR = "SERVER_ERROR"
NETWORK = "NETWORK"
OK = "OK"


class AllProvidersFailed(RuntimeError):
    """Alle Provider (inkl. lokalem Fallback) sind fehlgeschlagen."""

    def __init__(self, attempts: List[Dict[str, Any]]):
        self.attempts = attempts
        detail = ", ".join(
            f"{a['provider']}:{a['outcome']}" for a in attempts
        ) or "keine Versuche"
        super().__init__(f"Alle LLM-Provider nicht erreichbar ({detail})")


@dataclass
class CooldownPolicy:
    rate_limit: int = 120
    server_error: int = 60
    quota: int = 3600
    network: int = 30

    def seconds_for(self, outcome: str) -> int:
        return {
            RATE_LIMIT: self.rate_limit,
            SERVER_ERROR: self.server_error,
            QUOTA: self.quota,
            NETWORK: self.network,
        }.get(outcome, self.server_error)


@dataclass
class ProviderConfig:
    name: str
    kind: str
    base_url: str
    model: str
    priority: int = 100
    api_key_env: str = ""
    is_local: bool = False
    cooldown: CooldownPolicy = field(default_factory=CooldownPolicy)

    @property
    def chat_url(self) -> str:
        base = self.base_url.rstrip("/")
        return base + "/chat/completions"

    def api_key(self, env: Optional[Dict[str, str]] = None) -> str:
        source = env if env is not None else os.environ
        return (source.get(self.api_key_env, "") or "").strip()

    def configured(self, env: Optional[Dict[str, str]] = None) -> bool:
        return self.is_local or bool(self.api_key(env))


@dataclass
class LatenzStat:
    count: int = 0
    ok: int = 0
    fail: int = 0
    total_ms: float = 0.0
    last_ms: Optional[float] = None
    min_ms: Optional[float] = None
    max_ms: Optional[float] = None

    def record(self, ms: float, success: bool) -> None:
        self.count += 1
        self.total_ms += ms
        self.last_ms = ms
        self.min_ms = ms if self.min_ms is None else min(self.min_ms, ms)
        self.max_ms = ms if self.max_ms is None else max(self.max_ms, ms)
        if success:
            self.ok += 1
        else:
            self.fail += 1

    def as_dict(self) -> Dict[str, Any]:
        avg = round(self.total_ms / self.count, 1) if self.count else None
        return {
            "count": self.count,
            "ok": self.ok,
            "fail": self.fail,
            "avg_ms": avg,
            "last_ms": None if self.last_ms is None else round(self.last_ms, 1),
            "min_ms": None if self.min_ms is None else round(self.min_ms, 1),
            "max_ms": None if self.max_ms is None else round(self.max_ms, 1),
        }


def classify_status(status: int, body: str = "") -> str:
    """HTTP-Status + Body in eine Failover-Klasse übersetzen."""
    text = (body or "").lower()
    quota_markers = ("quota", "exceeded your current quota", "billing", "insufficient_quota")
    if status == 429:
        return QUOTA if any(m in text for m in quota_markers) else RATE_LIMIT
    if status in (401, 403):
        return QUOTA if any(m in text for m in quota_markers) else SERVER_ERROR
    if 500 <= status <= 599:
        return SERVER_ERROR
    return OK


class ResilienceRouter:
    """Ordnet Provider nach Priorität, macht Failover und führt Cooldowns."""

    def __init__(
        self,
        providers: Iterable[ProviderConfig],
        *,
        env: Optional[Dict[str, str]] = None,
        timeout_seconds: float = 45.0,
        transport: Optional[Callable[..., Awaitable[tuple]]] = None,
        clock: Callable[[], float] = time.monotonic,
        event_capacity: int = 200,
    ) -> None:
        self.providers: List[ProviderConfig] = sorted(providers, key=lambda p: p.priority)
        self.env = env
        self.timeout_seconds = float(timeout_seconds)
        self._transport = transport
        self._clock = clock
        self._cooldowns: Dict[str, Dict[str, Any]] = {}
        self.latency: Dict[str, LatenzStat] = {p.name: LatenzStat() for p in self.providers}
        self.events: Deque[Dict[str, Any]] = deque(maxlen=event_capacity)
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ intern
    def _emit(self, kind: str, **payload: Any) -> Dict[str, Any]:
        event = {"ts": time.time(), "kind": kind, **payload}
        self.events.append(event)
        if kind == "switch":
            log.warning(
                "Provider-Switch: %s -> %s (Grund: %s)",
                payload.get("from"), payload.get("to"), payload.get("reason"),
            )
        elif kind == "fail":
            log.warning(
                "Provider %s fehlgeschlagen: %s (%s ms)",
                payload.get("provider"), payload.get("outcome"), payload.get("latency_ms"),
            )
        else:
            log.info(
                "Provider %s ok in %s ms", payload.get("provider"), payload.get("latency_ms")
            )
        return event

    def _cooldown_remaining(self, provider: ProviderConfig) -> int:
        entry = self._cooldowns.get(provider.name)
        if not entry:
            return 0
        return max(0, int(entry["until"] - self._clock()))

    def _enter_cooldown(self, provider: ProviderConfig, outcome: str) -> int:
        seconds = provider.cooldown.seconds_for(outcome)
        if provider.is_local:
            seconds = min(seconds, 30)
        self._cooldowns[provider.name] = {
            "until": self._clock() + seconds,
            "outcome": outcome,
            "seconds": seconds,
        }
        return seconds

    def _candidates(self) -> List[ProviderConfig]:
        """Nicht konfigurierte Provider auslassen, Cooldowns ans Ende sortieren."""
        ready: List[ProviderConfig] = []
        for p in self.providers:
            if not p.configured(self.env):
                continue
            if self._cooldown_remaining(p) > 0:
                continue
            ready.append(p)
        return ready

    async def _post(self, provider: ProviderConfig, payload: Dict[str, Any], key: str) -> tuple:
        if self._transport is not None:
            return await self._transport(provider.chat_url, payload, key, self.timeout_seconds)
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        try:
            import aiohttp  # type: ignore

            timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(provider.chat_url, json=payload, headers=headers) as resp:
                    text = await resp.text()
                    return resp.status, text
        except ImportError:
            def _blocking() -> tuple:
                import urllib.error
                import urllib.request

                req = urllib.request.Request(
                    provider.chat_url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers=headers,
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=self.timeout_seconds) as r:
                        return r.getcode(), r.read().decode("utf-8", "replace")
                except urllib.error.HTTPError as exc:
                    return exc.code, exc.read().decode("utf-8", "replace")

            return await asyncio.to_thread(_blocking)

    @staticmethod
    def _extract_text(body: str) -> str:
        try:
            data = json.loads(body)
        except (TypeError, ValueError):
            return body.strip()
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            return data.get("message") or data.get("error") or body

    # -------------------------------------------------------------------- API
    async def complete(
        self,
        messages: List[Dict[str, str]],
        *,
        max_tokens: int = 512,
        temperature: float = 0.4,
    ) -> Dict[str, Any]:
        """Fordert eine Completion an und liefert Ergebnis inkl. Provider-Daten."""
        attempts: List[Dict[str, Any]] = []
        previous: Optional[ProviderConfig] = None

        for provider in self._candidates():
            if previous is not None:
                self._emit(
                    "switch",
                    **{"from": previous.name, "to": provider.name,
                       "reason": attempts[-1]["outcome"] if attempts else "unbekannt"},
                )
            previous = provider
            key = provider.api_key(self.env)
            payload = {
                "model": provider.model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
            started = self._clock()
            try:
                status, body = await self._post(provider, payload, key)
            except Exception as exc:  # Netzwerk, Timeout, DNS
                elapsed = (self._clock() - started) * 1000
                self.latency[provider.name].record(elapsed, False)
                wait = self._enter_cooldown(provider, NETWORK)
                attempts.append({"provider": provider.name, "outcome": NETWORK,
                                 "status": None, "latency_ms": round(elapsed, 1),
                                 "cooldown_s": wait, "error": str(exc)[:200]})
                self._emit("fail", provider=provider.name, outcome=NETWORK,
                           latency_ms=round(elapsed, 1), cooldown_s=wait)
                continue

            elapsed = (self._clock() - started) * 1000
            outcome = classify_status(int(status), body)
            if outcome == OK:
                self.latency[provider.name].record(elapsed, True)
                self._cooldowns.pop(provider.name, None)
                text = self._extract_text(body)
                attempts.append({"provider": provider.name, "outcome": OK,
                                 "status": status, "latency_ms": round(elapsed, 1)})
                self._emit("ok", provider=provider.name, latency_ms=round(elapsed, 1))
                return {
                    "text": text,
                    "provider": provider.name,
                    "model": provider.model,
                    "latency_ms": round(elapsed, 1),
                    "attempts": attempts,
                }

            self.latency[provider.name].record(elapsed, False)
            wait = self._enter_cooldown(provider, outcome)
            attempts.append({"provider": provider.name, "outcome": outcome,
                             "status": status, "latency_ms": round(elapsed, 1),
                             "cooldown_s": wait, "error": body[:200]})
            self._emit("fail", provider=provider.name, outcome=outcome,
                       latency_ms=round(elapsed, 1), cooldown_s=wait)

        # Alles belegt: lokal versuchen, auch wenn er als Fallback markiert ist.
        local = [p for p in self.providers if p.is_local and p.configured(self.env)]
        for provider in local:
            if any(a["provider"] == provider.name for a in attempts):
                continue
            self._emit("switch", **{"from": attempts[-1]["provider"] if attempts else "-",
                                   "to": provider.name, "reason": "alle externen belegt"})
            started = self._clock()
            payload = {"model": provider.model, "messages": messages,
                       "max_tokens": max_tokens, "temperature": temperature}
            try:
                status, body = await self._post(provider, payload, "")
            except Exception as exc:
                elapsed = (self._clock() - started) * 1000
                self.latency[provider.name].record(elapsed, False)
                attempts.append({"provider": provider.name, "outcome": NETWORK,
                                 "status": None, "latency_ms": round(elapsed, 1),
                                 "error": str(exc)[:200]})
                continue
            elapsed = (self._clock() - started) * 1000
            if int(status) == 200:
                self.latency[provider.name].record(elapsed, True)
                attempts.append({"provider": provider.name, "outcome": OK,
                                 "status": status, "latency_ms": round(elapsed, 1)})
                self._emit("ok", provider=provider.name, latency_ms=round(elapsed, 1))
                return {"text": self._extract_text(body), "provider": provider.name,
                        "model": provider.model, "latency_ms": round(elapsed, 1),
                        "attempts": attempts}
            self.latency[provider.name].record(elapsed, False)
            attempts.append({"provider": provider.name,
                             "outcome": classify_status(int(status), body),
                             "status": status, "latency_ms": round(elapsed, 1),
                             "error": body[:200]})

        raise AllProvidersFailed(attempts)

    def status(self) -> Dict[str, Any]:
        """Monitoring-Snapshot: Provider, Cooldowns, Latenzen, letzte Events."""
        return {
            "providers": [
                {
                    "name": p.name,
                    "kind": p.kind,
                    "priority": p.priority,
                    "model": p.model,
                    "local": p.is_local,
                    "configured": p.configured(self.env),
                    "cooldown_remaining_s": self._cooldown_remaining(p),
                    "latency": self.latency.get(p.name, LatenzStat()).as_dict(),
                }
                for p in self.providers
            ],
            "recent_events": list(self.events)[-20:],
        }

    def cooldowns(self) -> Dict[str, int]:
        return {name: self._cooldown_remaining_by_name(name) for name in list(self._cooldowns)}

    def _cooldown_remaining_by_name(self, name: str) -> int:
        entry = self._cooldowns.get(name)
        return max(0, int(entry["until"] - self._clock())) if entry else 0
