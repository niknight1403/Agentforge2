import pytest
from pydantic import ValidationError

from app.config import Settings


def test_empty_token_is_allowed_for_fail_closed_local_setup():
    settings = Settings(_env_file=None, api_token="")
    assert settings.api_token == ""


def test_short_or_placeholder_tokens_are_rejected():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, api_token="too-short")
    with pytest.raises(ValidationError):
        Settings(_env_file=None, api_token="replace-with-a-long-random-secret")


def test_long_random_token_is_accepted():
    token = "x" * 48
    settings = Settings(_env_file=None, api_token=token)
    assert settings.api_token == token
