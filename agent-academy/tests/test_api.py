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


@pytest.mark.asyncio
async def test_sync_rejects_duplicate_repository_names_before_import(monkeypatch):
    from app.api import endpoints
    from app.schemas import SyncRequest

    async def unexpected_clone(*_args, **_kwargs):
        raise AssertionError("duplicate names must be rejected before cloning")

    monkeypatch.setattr(endpoints.scanner, "clone_or_update", unexpected_clone)
    payload = SyncRequest(repositories=[
        {"name": "same", "url": "https://github.com/niknight1403/first"},
        {"name": "SAME", "url": "https://github.com/niknight1403/second"},
    ])
    with pytest.raises(HTTPException) as error:
        await endpoints.sync_repositories(payload)
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_audit_uses_all_indexed_paths_but_bounds_llm_evidence(monkeypatch):
    from app.api import endpoints
    from app.schemas import AnalyzeRequest

    files = [{"path": f"src/module_{index}.py", "language": "py"} for index in range(200)]
    files.append({"path": "tests/test_late_file.py", "language": "py"})
    monkeypatch.setattr(endpoints.store, "list_files", lambda _name: files)

    result = await endpoints.analyze_synergies(AnalyzeRequest(repository_names=["repo"], use_llm=False))

    assert result["audit"]["passed"] is True
    assert len(result["evidence"].splitlines()) == 201
