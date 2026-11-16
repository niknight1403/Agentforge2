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
    assert contains_secret('AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"')



def test_prefixed_and_underscored_secret_names_are_detected():
    assert contains_secret('_api_key = "credential-value"')
    assert contains_secret('DB__PASSWORD = "credential-value"')
    assert contains_secret('PAYMENT_API_KEY = "credential-value"')
    assert contains_secret('{"api_key":"credential-value"}')


def test_environment_lookup_is_not_treated_as_embedded_secret():
    assert not contains_secret('api_key = os.getenv("ACADEMY_API_TOKEN")')
    assert not contains_secret('api_key = process.env.ACADEMY_API_TOKEN')


def test_long_identifier_and_underscore_runs_are_bounded():
    assert not contains_secret(("a_" * 20000) + "not_a_secret")
    assert not contains_secret("_" * 40000)
