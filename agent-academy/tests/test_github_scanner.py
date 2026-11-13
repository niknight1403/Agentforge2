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
