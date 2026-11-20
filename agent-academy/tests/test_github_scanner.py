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
    assert contains_secret('refresh_token = "credential-value"')
    assert contains_secret('api_token = "credential-value"')
    assert contains_secret('access_token = "credential-value"')
    assert contains_secret('private_key = "credential-value"')
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


def test_parenthesized_python_string_credentials_are_detected_without_evaluating_expressions():
    assert contains_secret('password = ("liveCredential123")', ".py")
    assert not contains_secret('password = (os.getenv("APP_PASSWORD"))', ".py")
    assert not contains_secret('password = ("placeholder" + suffix)', ".py")


def test_json_null_is_not_a_credential_but_quoted_null_is():
    assert not contains_secret('{"api_key": null, "enabled": true}', ".json")
    assert contains_secret('{"api_key": "null"}', ".json")


def test_type_annotation_without_default_is_not_a_secret():
    assert not contains_secret("class Config:\n    password: str", ".py")


def test_yaml_values_are_not_mistaken_for_python_type_annotations_or_sibling_fields():
    assert contains_secret("password: string-fixture-value", ".yaml")
    assert contains_secret("password:\n  indented-secret-value", ".yaml")
    assert not contains_secret("password:\nhost: localhost", ".yaml")
    assert not contains_secret("password:\n  host: localhost", ".yaml")


def test_triple_quoted_credentials_are_detected():
    assert contains_secret('password = """fixture-value"""', ".py")
    assert contains_secret("password = '''fixture-value'''", ".py")


def test_os_getenv_literal_defaults_are_detected_but_plain_lookups_are_not():
    assert contains_secret('password = os.getenv("APP_PASSWORD", "fixture-value")', ".py")
    assert not contains_secret('password = os.getenv("APP_PASSWORD")', ".py")


def test_camel_case_credentials_are_detected():
    assert contains_secret('{"clientSecret":"fixture-value"}', ".json")
    assert not contains_secret('{"secretScanningEnabled":true}', ".json")


def test_generic_python_token_references_are_not_treated_as_embedded_credentials():
    assert not contains_secret("token = self.current_token", ".py")
    assert contains_secret('token = "literal-token-value"', ".py")


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
    (tmp_path / "settings-null.json").write_text('{"api_key": null, "enabled": true}\n', encoding="utf-8")

    chunks = asyncio.run(GitHubScanner().scan(tmp_path))
    paths = {item["path"] for item in chunks}
    assert {"credentials.py", "nested.py"}.isdisjoint(paths)
    assert {"schema.py", "settings.json", "settings-null.json"} <= paths
