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

    header = "-----BEGIN " + "PRIVATE KEY-----"
    footer = "-----END " + "PRIVATE KEY-----"
    assert contains_secret(header + "\\nredacted\\n" + footer)

def test_secret_marker_without_key_name_is_rejected():
    from app.ingestion.github_scanner import contains_secret

    prefix = "gh" + "p_"
    token = prefix + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
    assert contains_secret('GH = "' + token + '"')


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


def test_short_yaml_and_aws_credentials_are_rejected():
    from app.ingestion.github_scanner import contains_secret

    assert contains_secret('password: correct.horse.battery.staple')
    assert contains_secret('password = "admin"')
    assert contains_secret('AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"')


def test_secret_scanner_handles_long_underscore_runs_without_false_positive():
    from app.ingestion.github_scanner import contains_secret

    assert not contains_secret("ordinary_" * 4000)


@pytest.mark.asyncio
async def test_scan_does_not_index_unquoted_yaml_credentials(tmp_path):
    from app.ingestion.github_scanner import GitHubScanner

    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "config.yml").write_text("password: correct.horse.battery.staple\\n", encoding="utf-8")
    (repo / "README.md").write_text("# Public documentation\\n", encoding="utf-8")

    chunks = await GitHubScanner().scan(repo)

    assert [item["path"] for item in chunks] == ["README.md"]


def test_environment_lookup_is_not_mistaken_for_an_embedded_secret():
    from app.ingestion.github_scanner import contains_secret

    assert not contains_secret('api_key = os.getenv("ACADEMY_API_TOKEN")')
    assert not contains_secret('PAYMENT_API_KEY = process.env.PAYMENT_API_KEY')


def test_quoted_secret_values_keep_punctuation_and_prefixed_json_keys():
    from app.ingestion.github_scanner import contains_secret

    assert contains_secret('password = "ab#LongCredentialValue123"')
    assert contains_secret('password = "comma,value;with#punctuation123"')
    assert contains_secret('{"PAYMENT_API_KEY": "payment-secret-value-123"}')


@pytest.mark.asyncio
async def test_scan_keeps_file_that_reads_secret_from_environment(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    source = repo / "settings.py"
    source.write_text('api_key = os.getenv("ACADEMY_API_TOKEN")\\n', encoding="utf-8")

    chunks = await GitHubScanner().scan(repo)

    assert [item["path"] for item in chunks] == ["settings.py"]
