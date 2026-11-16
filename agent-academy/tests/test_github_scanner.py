from app.ingestion.github_scanner import contains_secret


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
    assert contains_secret('AWS_SECRET_ACCESS_KEY = "example-secret-value"')
