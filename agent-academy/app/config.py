from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ACADEMY_",
        env_file=".env",
        extra="ignore",
    )

    project_name: str = "Agent Academy"
    api_token: str = Field(default="", repr=False)

    @field_validator("api_token")
    @classmethod
    def reject_weak_token(cls, value: str) -> str:
        """Normalize the configured token before validating its strength."""
        value = value.strip()
        if value and (len(value) < 32 or value.lower().startswith(("replace-", "changeme", "your-"))):
            raise ValueError("ACADEMY_API_TOKEN must be a non-placeholder value of at least 32 characters")
        return value
    data_dir: Path = Path("./data")
    github_allowed_orgs: str = "niknight1403"
    max_file_bytes: int = Field(default=50_000, ge=1_024, le=1_000_000)
    default_model: str = "ollama/qwen2.5-coder:7b"
    ollama_base_url: str = "http://127.0.0.1:11434"
    llm_enabled: bool = False

    @property
    def allowed_orgs(self) -> set[str]:
        """Return the normalized GitHub owner allowlist."""
        return {item.strip().lower() for item in self.github_allowed_orgs.split(",") if item.strip()}


@lru_cache
def get_settings() -> Settings:
    """Load settings once and ensure the persistent data directory exists."""
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings


settings = get_settings()
