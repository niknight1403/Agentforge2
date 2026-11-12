import asyncio
import re
from pathlib import Path

from git import Repo

from app.config import settings

ALLOWED_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yml", ".yaml", ".toml", ".sql"}
IGNORED_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "coverage", ".next"}
IGNORED_NAMES = {".env", ".env.local", ".env.production", "id_rsa", "id_ed25519"}
SECRET_ASSIGNMENTS = re.compile(
    r"""(?im)(?<![A-Za-z0-9_-])_*(?:[A-Za-z0-9]+[_-]+)*(?:aws[_-]?secret[_-]?access[_-]?key|api[_-]?key|client[_-]?secret|secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)"?\\s*[:=]\\s*(?:(?P<quote>["'])(?P<quoted>(?:\\\\.|(?!(?P=quote))[^\\\\\\r\\n])*)(?P=quote)|(?P<bare>[^\\s#()]+)(?=\\s*(?:#.*)?$))"""
)
SECRET_MARKERS = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b",
    re.IGNORECASE,
)
SAFE_SECRET_PLACEHOLDERS = {"changeme", "change-me", "replace-me", "your_api_key", "your-token", "placeholder"}


class RepositoryTargetError(ValueError):
    """A controlled, user-correctable repository validation failure."""


def contains_secret(content: str) -> bool:
    """Return whether content matches known credential assignments or key formats."""
    sample = content
    if SECRET_MARKERS.search(sample):
        return True
    for match in SECRET_ASSIGNMENTS.finditer(sample):
        value = (match.group("quoted") or match.group("bare") or "").strip()
        if value.lower() not in SAFE_SECRET_PLACEHOLDERS and not value.lower().startswith(("your-", "replace-", "example")):
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
