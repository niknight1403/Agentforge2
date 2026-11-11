class AuditorAgent:
    """Deterministic first-pass quality auditor; it never equates indexing with verification."""

    def audit(self, repositories: dict[str, list[dict[str, str]]]) -> dict:
        findings = []
        for name, files in repositories.items():
            paths = {item["path"] for item in files}
            if not files:
                findings.append({"repository": name, "severity": "error", "finding": "No source files indexed"})
            if "README.md" not in paths and "readme.md" not in paths:
                findings.append({"repository": name, "severity": "warning", "finding": "README is missing"})
            if not any(path.startswith(("tests/", "test/")) or path.startswith("__tests__/") for path in paths):
                findings.append({"repository": name, "severity": "warning", "finding": "No conventional test directory indexed"})
        return {"passed": not any(item["severity"] == "error" for item in findings), "findings": findings}
