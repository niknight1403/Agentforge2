import asyncio
import re
from pathlib import Path

from git import Repo

from app.config import settings

ALLOWED_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yml", ".yaml", ".toml", ".sql"}
IGNORED_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "coverage", ".next"}
IGNORED_NAMES = {".env", ".env.local", ".env.production", "id_rsa", "id_ed25519"}
SECRET_KEY_CANDIDATES = re.compile(
    r"""(?im)(?<![A-Za-z0-9_-])["']?(?P<key>_*[A-Za-z0-9][A-Za-z0-9_-]*)["']?\s*(?P<separator>[:=])"""
)
SECRET_MARKERS = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b",
    re.IGNORECASE,
)
SAFE_SECRET_PLACEHOLDERS = {"changeme", "change-me", "replace-me", "your_api_key", "your-token", "placeholder"}
SECRET_KEY_PARTS = (
    "aws_secret_access_key", "api_key", "client_secret", "secret",
    "password", "passwd", "access_token", "auth_token", "private_key",
)
TYPE_ANNOTATIONS = {"str", "string", "bytes", "int", "bool", "float", "any", "dict", "list"}


class RepositoryTargetError(ValueError):
    """A controlled, user-correctable repository validation failure."""


def _assignment_value(content: str, offset: int, separator: str) -> str | None:
    """Read one scalar assignment value, ignoring type-only declarations and env lookups."""
    pos = offset
    while pos < len(content) and content[pos].isspace():
        pos += 1

    if separator == ":":
        annotation = re.match(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\r\n]*\])?", content[pos:])
        if annotation:
            annotation_name = annotation.group(0).split("[", 1)[0].lower()
            after_annotation = pos + annotation.end()
            while after_annotation < len(content) and content[after_annotation].isspace():
                after_annotation += 1
            if after_annotation < len(content) and content[after_annotation] == "=":
                pos = after_annotation + 1
            elif annotation_name in TYPE_ANNOTATIONS:
                return None

    while pos < len(content) and content[pos].isspace():
        pos += 1
    if pos >= len(content):
        return ""

    if content[pos] in {"'", '"'}:
        quote = content[pos]
        pos += 1
        value = []
        while pos < len(content) and content[pos] not in "\r\n":
            char = content[pos]
            if char == "\\" and pos + 1 < len(content):
                value.append(content[pos + 1])
                pos += 2
                continue
            if char == quote:
                break
            value.append(char)
            pos += 1
        return "".join(value)

    if re.match(
        r"(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*|env\.[A-Za-z_][A-Za-z0-9_]*)\b",
        content[pos:],
        re.IGNORECASE,
    ):
        return None
    if re.match(r"[A-Za-z_][A-Za-z0-9_.]*\s*\(", content[pos:]):
        return None
    if re.match(r"os\.environ\s*\[", content[pos:], re.IGNORECASE):
        return None

    value_match = re.match(r"[^\s#(),;]+", content[pos:])
    return value_match.group(0) if value_match else ""


def contains_secret(content: str) -> bool:
    """Return whether content contains known credential assignments or key formats."""
    if SECRET_MARKERS.search(content):
        return True
    for match in SECRET_KEY_CANDIDATES.finditer(content):
        key = match.group("key").lower().replace("-", "_").strip("_")
        if not any(key == part or key.endswith("_" + part) for part in SECRET_KEY_PARTS):
            continue
        value = _assignment_value(content, match.end(), match.group("separator"))
        if value is None or not value.strip():
            continue
        normalized = value.strip().lower()
        if normalized not in SAFE_SECRET_PLACEHOLDERS and not normalized.startswith(
            ("your-", "replace-", "example")
        ):
            return True
    return False

class GitHubScanner:
    def _validate_target(self, name: str, url: str) -> None:
        """Validate repository names, canonical GitHub HTTPS URLs and owner allowlist."""
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", name):
            raise RepositoryTargetError("Invalid repository name")
        match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?", url)
        if not match:
            raise RepositoryTargetError("Repository URL must be a canonical GitHub HTTPS URL")
        if match.group(1).lower() not in settings.allowed_orgs:
            raise RepositoryTargetError("Repository owner is not in ACADEMY_GITHUB_ALLOWED_ORGS")

    async def clone_or_update(self, name: str, url: str) -> Path:
        """Clone or fast-forward an allowlisted repository into the confined data root."""
        self._validate_target(name, url)
        destination = (settings.data_dir / "repos" / name).resolve()
        root = (settings.data_dir / "repos").resolve()
        if root not in destination.parents:
            raise RepositoryTargetError("Repository path escapes the data directory")

        def operation() -> Path:
            if destination.exists():
                repo = Repo(destination)
                if repo.bare or "origin" not in repo.remotes:
                    raise RepositoryTargetError("Existing checkout is not a valid managed repository")
                if repo.remotes.origin.url != url:
                    raise RepositoryTargetError("Repository URL does not match the existing checkout")
                repo.remotes.origin.pull()
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                Repo.clone_from(url, destination, depth=1, multi_options=["--filter=blob:none"])
            return destination

        return await asyncio.to_thread(operation)

    async def scan(self, repo_path: Path) -> list[dict[str, str]]:
        """Collect supported, bounded, non-symlink source files without recognized secrets."""
        def operation() -> list[dict[str, str]]:
            chunks: list[dict[str, str]] = []
            for path in repo_path.rglob("*"):
                relative = path.relative_to(repo_path)
                if not path.is_file() or any(part in IGNORED_DIRS for part in relative.parts[:-1]):
                    continue
                if path.name in IGNORED_NAMES or path.suffix.lower() not in ALLOWED_SUFFIXES:
                    continue
                try:
                    if path.is_symlink() or path.stat().st_size > settings.max_file_bytes:
                        continue
                    content = path.read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    continue
                # Never index files with credential assignments or recognizable secret formats.
                if contains_secret(content):
                    continue
                chunks.append({
                    "path": path.relative_to(repo_path).as_posix(),
                    "language": path.suffix.lstrip(".").lower(),
                    "content": content,
                })
            return chunks

        return await asyncio.to_thread(operation)
