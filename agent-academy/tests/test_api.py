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
