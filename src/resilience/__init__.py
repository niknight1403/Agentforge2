"""Resilience-Paket: hochverfügbares LLM-Routing für AgentForge2."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .router import (
    AllProvidersFailed,
    CooldownPolicy,
    LatenzStat,
    ProviderConfig,
    ResilienceRouter,
    classify_status,
)

__all__ = [
    "AllProvidersFailed",
    "CooldownPolicy",
    "LatenzStat",
    "ProviderConfig",
    "ResilienceRouter",
    "classify_status",
    "load_env_file",
    "load_config",
    "build_router",
    "DEFAULT_CONFIG_PATH",
]
__version__ = "1.0.0"

# repo-wurzel/config/resilience_config.yaml
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "resilience_config.yaml"

# Eingebettete Defaults: greifen, wenn keine YAML vorhanden ist (kein Blocker).
_DEFAULT_PROVIDERS: List[Dict[str, Any]] = [
    {"name": "gemini-free", "kind": "gemini", "priority": 10,
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
     "model": "gemini-2.0-flash", "api_key_env": "GEMINI_API_KEY"},
    {"name": "groq-free", "kind": "groq", "priority": 20,
     "base_url": "https://api.groq.com/openai/v1",
     "model": "openai/gpt-oss-120b", "api_key_env": "GROQ_API_KEY"},
    {"name": "openrouter-free", "kind": "openrouter", "priority": 30,
     "base_url": "https://openrouter.ai/api/v1",
     "model": "google/gemma-4-31b-it:free", "api_key_env": "OPENROUTER_API_KEY"},
    {"name": "ollama-local", "kind": "ollama", "priority": 90, "is_local": True,
     "base_url": "http://localhost:11434/v1",
     "model": "llama3.2:3b", "api_key_env": ""},
]


def load_env_file(path: str | Path = ".env", *, override: bool = False) -> Dict[str, str]:
    """Liest KEY=VALUE aus .env, ohne zu blockieren wenn die Datei fehlt."""
    loaded: Dict[str, str] = {}
    p = Path(path)
    if not p.is_file():
        return loaded
    try:
        for raw in p.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if not key or (key in os.environ and not override):
                continue
            os.environ[key] = value
            loaded[key] = value
    except OSError:
        return loaded
    return loaded


def load_config(path: Optional[str | Path] = None) -> Dict[str, Any]:
    """YAML-Konfiguration laden; fehlende Datei/PyYAML => eingebettete Defaults."""
    cfg_path = Path(path) if path else DEFAULT_CONFIG_PATH
    data: Dict[str, Any] = {}
    if cfg_path.is_file():
        try:
            import yaml  # type: ignore

            data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        except Exception:  # YAML defekt oder PyYAML fehlt -> Defaults
            data = {}
    if not data.get("providers"):
        data = {"providers": _DEFAULT_PROVIDERS,
                "defaults": {"timeout_seconds": 45.0},
                "cooldowns": {"rate_limit": 120, "server_error": 60,
                              "quota": 3600, "network": 30}}
    return data


def build_router(
    config: Optional[Dict[str, Any]] = None,
    *,
    env: Optional[Dict[str, str]] = None,
    transport=None,
) -> ResilienceRouter:
    """Erzeugt aus Config einen fertigen Router (ohne Netzwerkzugriff)."""
    cfg = config or load_config()
    cds = cfg.get("cooldowns") or {}
    policy = CooldownPolicy(
        rate_limit=int(cds.get("rate_limit", 120)),
        server_error=int(cds.get("server_error", 60)),
        quota=int(cds.get("quota", 3600)),
        network=int(cds.get("network", 30)),
    )
    providers: List[ProviderConfig] = []
    for item in cfg.get("providers", []):
        own = item.get("cooldowns") or {}
        c = CooldownPolicy(
            rate_limit=int(own.get("rate_limit", policy.rate_limit)),
            server_error=int(own.get("server_error", policy.server_error)),
            quota=int(own.get("quota", policy.quota)),
            network=int(own.get("network", policy.network)),
        )
        providers.append(
            ProviderConfig(
                name=str(item["name"]),
                kind=str(item.get("kind", "openai-compatible")),
                base_url=str(item["base_url"]),
                model=str(item.get("model", "")),
                priority=int(item.get("priority", 100)),
                api_key_env=str(item.get("api_key_env", "")),
                is_local=bool(item.get("is_local", False)),
                cooldown=c,
            )
        )
    defaults = cfg.get("defaults") or {}
    return ResilienceRouter(
        providers,
        env=env,
        timeout_seconds=float(defaults.get("timeout_seconds", 45.0)),
        transport=transport,
    )
