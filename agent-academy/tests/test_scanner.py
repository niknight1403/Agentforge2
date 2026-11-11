import pytest

from app.ingestion.github_scanner import GitHubScanner


def test_rejects_non_github_url():
    with pytest.raises(ValueError):
        GitHubScanner()._validate_target("repo", "https://example.com/owner/repo")


def test_rejects_unapproved_owner(monkeypatch):
    with pytest.raises(ValueError):
        GitHubScanner()._validate_target("repo", "https://github.com/other/repo")


def test_rejects_path_traversal():
    with pytest.raises(ValueError):
        GitHubScanner()._validate_target("../outside", "https://github.com/niknight1403/repo")

def test_secret_assignment_without_provider_marker_is_rejected():
    from app.ingestion.github_scanner import contains_secret

    assert contains_secret('api_key = "ordinary-looking-secret-value-123"')


def test_placeholder_secret_assignment_is_allowed():
    from app.ingestion.github_scanner import contains_secret

    assert not contains_secret('api_key = "replace-me"')


def test_private_key_pem_is_rejected():
    from app.ingestion.github_scanner import contains_secret

    assert contains_secret("-----BEGIN PRIVATE KEY-----\\nredacted\\n-----END PRIVATE KEY-----")
