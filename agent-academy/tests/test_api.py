import pytest
from fastapi import HTTPException

from app.api.endpoints import require_token
from app.config import settings


@pytest.mark.asyncio
async def test_bearer_scheme_is_required_and_case_insensitive(monkeypatch):
    monkeypatch.setattr(settings, "api_token", "a" * 40)
    await require_token("bEaReR " + "a" * 40)
    with pytest.raises(HTTPException) as error:
        await require_token("a" * 40)
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_non_ascii_authorization_returns_401_not_500(monkeypatch):
    monkeypatch.setattr(settings, "api_token", "a" * 40)
    with pytest.raises(HTTPException) as error:
        await require_token("Bearer geheim-ä")
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_missing_service_token_fails_closed(monkeypatch):
    monkeypatch.setattr(settings, "api_token", "")
    with pytest.raises(HTTPException) as error:
        await require_token("Bearer anything")
    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_sync_does_not_expose_unexpected_value_error(monkeypatch):
    from app.api import endpoints
    from app.schemas import SyncRequest

    async def fail_clone(*_args, **_kwargs):
        raise ValueError("/srv/private/checkout/configuration detail")

    monkeypatch.setattr(endpoints.scanner, "clone_or_update", fail_clone)
    payload = SyncRequest(repositories=[{"name": "repo", "url": "https://github.com/niknight1403/repo"}])
    result = await endpoints.sync_repositories(payload)

    assert result["status"] == "partial"
    assert result["repositories"]["repo"] == {
        "status": "failed",
        "error": "Internal error during sync",
    }


@pytest.mark.asyncio
async def test_sync_returns_safe_repository_validation_message(monkeypatch):
    from app.api import endpoints
    from app.ingestion.github_scanner import RepositoryValidationError
    from app.schemas import SyncRequest

    async def reject_target(*_args, **_kwargs):
        raise RepositoryValidationError("Repository owner is not allowlisted")

    monkeypatch.setattr(endpoints.scanner, "clone_or_update", reject_target)
    payload = SyncRequest(repositories=[{"name": "repo", "url": "https://github.com/niknight1403/repo"}])
    result = await endpoints.sync_repositories(payload)

    assert result["repositories"]["repo"] == {
        "status": "failed",
        "error": "Repository owner is not allowlisted",
    }
