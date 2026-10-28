"""
HeinBot Resilience Cog — offizieller Wrapper des ResilienceRouter für AgentForge2.

Zwei Betriebsarten:
  * Mit discord.py (`discord` importierbar): klassische Cog inkl. `setup(bot)`.
  * Ohne discord.py: generisches Modul mit `setup(registry)` und `ask()`.

Die Cog liest API-Keys aus .env / Umgebung und blockiert nie, wenn ein Key
fehlt — fehlende Keys überspringen den Provider lediglich.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from resilience import (
    AllProvidersFailed,
    ResilienceRouter,
    build_router,
    load_config,
    load_env_file,
)

log = logging.getLogger("agentforge2.cogs.resilience")

COG_NAME = "heinbot_resilience"
COG_VERSION = "1.0.0"

try:  # discord.py ist optional — nur wenn vorhanden, echte Cog-Basis
    from discord.ext import commands as _dp_commands

    _CogBase = _dp_commands.Cog
    _HAS_DISCORD = True
except Exception:  # pragma: no cover - Umgebung ohne discord.py
    _dp_commands = None  # type: ignore
    _HAS_DISCORD = False

    class _CogBase:  # minimaler Ersatz, damit die Klasse überall existiert
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass


class HeinbotResilienceCog(_CogBase):
    """Stellt den ResilienceRouter als Cog/Modul bereit."""

    name = COG_NAME
    version = COG_VERSION

    def __init__(
        self,
        bot: Any = None,
        *,
        config_path: Optional[str | Path] = None,
        env_file: str | Path = ".env",
        transport=None,
    ) -> None:
        if _HAS_DISCORD:
            super().__init__()
        self.bot = bot
        self._env_file = env_file
        self._loaded_keys: List[str] = []
        self._config: Dict[str, Any] = {}
        self.router: Optional[ResilienceRouter] = None
        self._config_path = config_path
        # transport wird fuer Tests/Offline-Betrieb durchgereicht
        self._transport = transport

    # ------------------------------------------------------------------ Lifecycle
    async def cog_load(self) -> None:  # discord.py ruft das automatisch auf
        await self.async_setup()

    async def async_setup(self) -> None:
        """Keys laden, Config lesen, Router bauen — ohne Netzwerkzugriff."""
        loaded = load_env_file(self._env_file)
        self._loaded_keys = sorted(loaded)
        if self._loaded_keys:
            log.info("Resilience-Cog: %d Key(s) aus %s geladen", len(self._loaded_keys), self._env_file)
        else:
            log.info("Resilience-Cog: keine .env gefunden, nutze Prozess-Umgebung")
        self._config = load_config(self._config_path)
        self.router = build_router(self._config, transport=self._transport)
        missing = [
            p.name for p in self.router.providers
            if not p.configured() and not p.is_local
        ]
        if missing:
            log.warning(
                "Resilience-Cog: Provider ohne Key werden übersprungen: %s", ", ".join(missing)
            )
        log.info(
            "Resilience-Cog bereit mit %d Provider(n), lokal: %s",
            len(self.router.providers),
            [p.name for p in self.router.providers if p.is_local],
        )

    async def cog_unload(self) -> None:
        self.router = None

    # ------------------------------------------------------------------ Kern-API
    async def ask(
        self,
        prompt: str,
        *,
        system: Optional[str] = None,
        max_tokens: int = 512,
        temperature: float = 0.4,
    ) -> Dict[str, Any]:
        """Eine Anfrage über die Failover-Kette; Ergebnis mit Provider-Info."""
        if self.router is None:
            await self.async_setup()
        router = self.router
        assert router is not None
        messages: List[Dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        try:
            return await router.complete(
                messages, max_tokens=max_tokens, temperature=temperature
            )
        except AllProvidersFailed as exc:
            log.error("Alle Provider gescheitert: %s", exc)
            return {"text": "", "provider": None, "error": str(exc),
                    "attempts": exc.attempts}

    def status(self) -> Dict[str, Any]:
        """Monitoring-Daten (Cooldowns, Latenzen, Events) für API/Debug."""
        if self.router is None:
            return {"ready": False, "cog": COG_NAME, "version": COG_VERSION}
        snapshot = self.router.status()
        snapshot.update({"ready": True, "cog": COG_NAME, "version": COG_VERSION,
                         "env_keys_loaded": self._loaded_keys})
        return snapshot


# ---------------------------------------------------------------------- Setup
def setup(registry: Any) -> HeinbotResilienceCog:
    """Registriert die Cog — funktioniert mit discord.py-Bot oder Registry-Dict."""
    cog = HeinbotResilienceCog(registry if _HAS_DISCORD else None)
    if _HAS_DISCORD and _dp_commands is not None:
        # Aufruf erfolgt aus bot.add_cog; setup() wird von discord erwartet.
        return cog
    if hasattr(registry, "register"):
        registry.register(COG_NAME, cog)
    elif isinstance(registry, dict):
        registry[COG_NAME] = cog
    return cog


async def setup_async(registry: Any = None) -> HeinbotResilienceCog:
    """Convenience für Skripte: Cog bauen und sofort einsatzbereit machen."""
    cog = HeinbotResilienceCog(registry if _HAS_DISCORD else None)
    await cog.async_setup()
    return cog
