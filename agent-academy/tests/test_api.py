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
async def test_analyzer_receives_all_indexed_files_while_evidence_stays_bounded(monkeypatch):
    from app.api import endpoints
    from app.schemas import AnalyzeRequest

    files = [
        {"path": f"src/module_{index}.py", "language": "py", "content": "source"}
        for index in range(200)
    ]
    files.append({"path": "tests/test_late.py", "language": "py", "content": "test"})
    captured = {}
    monkeypatch.setattr(endpoints.store, "list_files", lambda _name: files)
    monkeypatch.setattr(
        endpoints.AuditorAgent,
        "audit",
        lambda self, repositories: captured.update(repositories) or {"count": len(repositories["sample"])},
    )

    result = await endpoints.analyze_synergies(AnalyzeRequest(repository_names=["sample"]))

    assert len(captured["sample"]) == 201
    assert captured["sample"][-1]["path"] == "tests/test_late.py"
    assert "tests/test_late.py" not in result["evidence"]


@pytest.mark.asyncio
async def test_unexpected_value_error_during_sync_is_not_returned_to_client(monkeypatch):
    from app.api import endpoints
    from app.schemas import SyncRequest

    async def unexpected_failure(*_args, **_kwargs):
        raise ValueError("private filesystem path /srv/private/repo")

    monkeypatch.setattr(endpoints.scanner, "clone_or_update", unexpected_failure)
    payload = SyncRequest(repositories=[{
        "name": "sample",
        "url": "https://github.com/niknight1403/sample",
    }])

    result = await endpoints.sync_repositories(payload)

    assert result["repositories"]["sample"]["status"] == "failed"
    assert result["repositories"]["sample"]["error"] == "Internal error during sync"
