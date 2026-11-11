from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ACADEMY_",
        env_file=".env",
        extra="ignore",
    )

    project_name: str = "Agent Academy"
    api_token: str = Field(default="", repr=False)
    data_dir: Path = Path("./data")
    github_allowed_orgs: str = "niknight1403"
    max_file_bytes: int = Field(default=50_000, ge=1_024, le=1_000_000)
    default_model: str = "ollama/qwen2.5-coder:7b"
    ollama_base_url: str = "http://127.0.0.1:11434"
    llm_enabled: bool = False

    @property
    def allowed_orgs(self) -> set[str]:
        return {item.strip().lower() for item in self.github_allowed_orgs.split(",") if item.strip()}


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings


settings = get_settings()
