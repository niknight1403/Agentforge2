from app.agents.auditor import AuditorAgent


def test_auditor_reports_missing_tests():
    result = AuditorAgent().audit({
        "sample": [{"path": "README.md", "language": "md", "content": "project"}]
    })
    assert result["passed"] is True
    assert any("test directory" in item["finding"] for item in result["findings"])


def test_auditor_fails_empty_repository():
    result = AuditorAgent().audit({"empty": []})
    assert result["passed"] is False
