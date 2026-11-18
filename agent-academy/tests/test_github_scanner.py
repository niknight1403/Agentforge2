import asyncio

from app.ingestion.github_scanner import GitHubScanner, contains_secret


def test_secret_assignment_allows_opposite_quote_inside_value():
    assert contains_secret('password = "abc\'def123456"')
    assert contains_secret("password = 'abc\"def123456'")


def test_secret_assignment_handles_escaped_delimiter():
    assert contains_secret('password = "abc\\\"def123456"')
    assert contains_secret("password = 'abc\\\'def123456'")


def test_secret_placeholders_remain_excluded():
    assert not contains_secret('password = "your-token"')
    assert not contains_secret('password = "replace-me"')


def test_short_quoted_credential_values_are_detected():
    assert contains_secret('password = "admin"')


def test_dotted_unquoted_yaml_secret_values_are_detected():
    assert contains_secret("password: correct.horse.battery.staple")


def test_aws_secret_access_key_assignment_is_detected():
    assert contains_secret('AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"')



def test_prefixed_and_underscored_secret_names_are_detected():
    assert contains_secret('_api_key = "credential-value"')
    assert contains_secret('DB__PASSWORD = "credential-value"')
    assert contains_secret('PAYMENT_API_KEY = "credential-value"')
    assert contains_secret('GITHUB_TOKEN = "credential-value"')
    assert contains_secret('{"api_key":"credential-value"}')


def test_environment_lookup_is_not_treated_as_embedded_secret():
    assert not contains_secret('api_key = os.getenv("ACADEMY_API_TOKEN")')
    assert not contains_secret('api_key = process.env.ACADEMY_API_TOKEN')


def test_long_identifier_and_underscore_runs_are_bounded():
    assert not contains_secret(("a_" * 20000) + "not_a_secret")
    assert not contains_secret("_" * 40000)



def test_typed_secret_assignment_is_detected():
    assert contains_secret('api_key: str = "liveCredential123"')
    assert contains_secret('password: str = "str"')


def test_nested_object_credentials_are_detected_without_losing_outer_context():
    assert contains_secret('settings = {"api_key":"credential-value"}')
    assert contains_secret('x = { "api_key": "credential-value" }')
    assert contains_secret('{"password":"***REDACTED_SECRET_ASSIGNMENT***"}')
    assert not contains_secret('settings = {"secret_scanning_enabled": true}')


def test_secret_configuration_flags_are_not_credentials():
    assert not contains_secret("secret_scanning_enabled = True")
    assert not contains_secret("secret_scanning_enabled: bool = True")


def test_empty_secret_values_are_not_credentials():
    assert not contains_secret('{"api_key": ""}')
    assert not contains_secret('api_key = ""')
    assert not contains_secret("password = ''")


def test_type_annotation_without_default_is_not_a_secret():
    assert not contains_secret("class Config:\n    password: str")


def test_scan_excludes_typed_and_nested_credentials_but_keeps_schema_and_empty_config(tmp_path):
    (tmp_path / "credentials.py").write_text(
        'api_key: str = "liveCredential123"\npassword: str = "str"\n',
        encoding="utf-8",
    )
    (tmp_path / "nested.py").write_text(
        'settings = {"api_key":"credential-value"}\n',
        encoding="utf-8",
    )
    (tmp_path / "schema.py").write_text("class Config:\n    password: str\n", encoding="utf-8")
    (tmp_path / "settings.json").write_text('{"api_key": ""}\n', encoding="utf-8")

    chunks = asyncio.run(GitHubScanner().scan(tmp_path))
    paths = {item["path"] for item in chunks}
    assert {"credentials.py", "nested.py"}.isdisjoint(paths)
    assert {"schema.py", "settings.json"} <= paths
