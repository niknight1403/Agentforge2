from pydantic import BaseModel, Field, HttpUrl, field_validator


class RepositoryTarget(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+$")
    url: HttpUrl

    @field_validator("url")
    @classmethod
    def github_https_only(cls, value: HttpUrl) -> HttpUrl:
        if value.scheme != "https" or value.host not in {"github.com", "www.github.com"}:
            raise ValueError("Only HTTPS GitHub repository URLs are allowed")
        if value.username or value.password or value.query or value.fragment:
            raise ValueError("Credentials, query strings and fragments are not allowed")
        return value


class SyncRequest(BaseModel):
    repositories: list[RepositoryTarget] = Field(min_length=1, max_length=10)


class AnalyzeRequest(BaseModel):
    repository_names: list[str] = Field(default_factory=list, max_length=10)
    use_llm: bool = False


class OptimizeRequest(BaseModel):
    execution_logs: str = Field(min_length=1, max_length=20_000)
    use_llm: bool = False
