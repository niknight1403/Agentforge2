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

def test_secret_marker_without_key_name_is_rejected():
    from app.ingestion.github_scanner import contains_secret

    assert contains_secret('GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"')


def test_secret_after_previous_scan_limit_is_rejected():
    from app.ingestion.github_scanner import contains_secret

    assert contains_secret(("ordinary text " * 900) + 'api_key = "secret-value-123456789"')


def test_common_word_fragment_is_not_a_secret():
    from app.ingestion.github_scanner import contains_secret

    assert not contains_secret("The word makia appears in ordinary documentation.")


@pytest.mark.asyncio
async def test_scan_ignores_only_repository_relative_directories(tmp_path):
    from app.ingestion.github_scanner import GitHubScanner

    repo = tmp_path / "build" / "academy" / "repos" / "sample"
    source = repo / "src" / "worker.py"
    source.parent.mkdir(parents=True)
    source.write_text("def run_task(): return True", encoding="utf-8")

    chunks = await GitHubScanner().scan(repo)

    assert [item["path"] for item in chunks] == ["src/worker.py"]
