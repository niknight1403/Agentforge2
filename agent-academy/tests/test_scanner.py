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
