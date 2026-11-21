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
    "password", "passwd", "access_token", "auth_token", "token", "private_key",
)
TYPE_ANNOTATIONS = {"str", "string", "bytes", "int", "bool", "float", "any", "dict", "list"}
TYPE_ANNOTATION_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\r\n]*\])?")
ENV_LOOKUP_PATTERN = re.compile(
    r"(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*|env\.[A-Za-z_][A-Za-z0-9_]*)\b",
    re.IGNORECASE,
)
CALL_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*\s*\(")
OS_ENVIRON_PATTERN = re.compile(r"os\.environ\s*\[", re.IGNORECASE)
OS_GETENV_PATTERN = re.compile(r"os\.getenv\s*\(", re.IGNORECASE)
BARE_VALUE_PATTERN = re.compile(r"[^\s#(),;]+")
YAML_MAPPING_KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]+:[ \t]+")


class RepositoryTargetError(ValueError):
    """A controlled, user-correctable repository validation failure."""


# Backwards-compatible name retained for Agent Academy callers/tests.
RepositoryValidationError = RepositoryTargetError


def _read_quoted_value(content: str, pos: int) -> tuple[str, int] | None:
    """Read a single- or triple-quoted scalar and return its value and end offset."""
    quote = content[pos]
    delimiter = quote * 3 if content.startswith(quote * 3, pos) else quote
    cursor = pos + len(delimiter)
    value: list[str] = []
    while cursor < len(content):
        if content.startswith(delimiter, cursor):
            return "".join(value), cursor + len(delimiter)
        char = content[cursor]
        if char == "\\" and cursor + 1 < len(content):
            value.append(content[cursor + 1])
            cursor += 2
            continue
        if len(delimiter) == 1 and char in "\r\n":
            return None
        value.append(char)
        cursor += 1
    return "".join(value), cursor


def _os_getenv_default(content: str, pos: int) -> str | None:
    """Return a literal second os.getenv argument, if one is present."""
    call = OS_GETENV_PATTERN.match(content, pos)
    if not call:
        return None
    cursor = call.end()
    while cursor < len(content) and content[cursor] in " \t":
        cursor += 1
    first = _read_quoted_value(content, cursor) if cursor < len(content) and content[cursor] in {"'", '"'} else None
    if first is None:
        return None
    cursor = first[1]
    while cursor < len(content) and content[cursor] in " \t":
        cursor += 1
    if cursor >= len(content) or content[cursor] != ",":
        return None
    cursor += 1
    while cursor < len(content) and content[cursor] in " \t":
        cursor += 1
    if cursor >= len(content) or content[cursor] not in {"'", '"'}:
        return None
    second = _read_quoted_value(content, cursor)
    return second[0] if second is not None else None


def _assignment_value(
    content: str,
    offset: int,
    separator: str,
    *,
    python_source: bool = False,
    literal_only: bool = False,
    json_source: bool = False,
) -> str | None:
    """Read one scalar value without crossing a YAML field boundary or copying the file tail."""
    pos = offset
    while pos < len(content) and content[pos] in " \t\f":
        pos += 1

    if separator == ":" and python_source:
        annotation = TYPE_ANNOTATION_PATTERN.match(content, pos)
        if annotation:
            annotation_name = annotation.group(0).split("[", 1)[0].lower()
            after_annotation = annotation.end()
            while after_annotation < len(content) and content[after_annotation] in " \t\f":
                after_annotation += 1
            if after_annotation < len(content) and content[after_annotation] == "=":
                pos = after_annotation + 1
            elif annotation_name in TYPE_ANNOTATIONS:
                return None

    while pos < len(content) and content[pos] in " \t\f":
        pos += 1
    if pos < len(content) and content[pos] in "\r\n":
        if separator != ":" or python_source:
            return ""
        line_start = content.rfind("\n", 0, offset) + 1
        key_prefix = content[line_start:offset]
        key_indent = len(key_prefix) - len(key_prefix.lstrip(" \t"))
        cursor = pos
        found_value = False
        while cursor < len(content) and content[cursor] in "\r\n":
            if content.startswith("\r\n", cursor):
                cursor += 2
            else:
                cursor += 1
            next_line_start = cursor
            while cursor < len(content) and content[cursor] in " \t":
                cursor += 1
            if cursor >= len(content):
                return ""
            if content[cursor] == "#" or content[cursor] in "\r\n":
                while cursor < len(content) and content[cursor] not in "\r\n":
                    cursor += 1
                continue
            next_indent = cursor - next_line_start
            if next_indent <= key_indent or YAML_MAPPING_KEY_PATTERN.match(content, cursor):
                return ""
            pos = cursor
            found_value = True
            break
        if not found_value:
            return ""
    if pos >= len(content):
        return ""

    if python_source and content[pos] == "(":
        literal_pos = pos + 1
        while literal_pos < len(content) and content[literal_pos] in " \t\r\n":
            literal_pos += 1
        if literal_pos < len(content) and content[literal_pos] in {"'", '"'}:
            parenthesized = _read_quoted_value(content, literal_pos)
            if parenthesized is not None:
                closing = parenthesized[1]
                while closing < len(content) and content[closing] in " \t":
                    closing += 1
                if closing < len(content) and content[closing] == ")":
                    return parenthesized[0]

    if content[pos] in {"'", '"'}:
        quoted = _read_quoted_value(content, pos)
        return quoted[0] if quoted is not None else None

    if python_source:
        default_value = _os_getenv_default(content, pos)
        if default_value is not None:
            return default_value
        if literal_only:
            return None

    if ENV_LOOKUP_PATTERN.match(content, pos) or OS_ENVIRON_PATTERN.match(content, pos):
        return None
    if CALL_PATTERN.match(content, pos):
        return None

    value_match = BARE_VALUE_PATTERN.match(content, pos)
    value = value_match.group(0) if value_match else ""
    if json_source and value.lower() == "null":
        return None
    return value


def contains_secret(content: str, source_suffix: str | None = None) -> bool:
    """Return whether content contains known credential assignments or key formats."""
    if SECRET_MARKERS.search(content):
        return True
    python_source = source_suffix == ".py" if source_suffix is not None else True
    for match in SECRET_KEY_CANDIDATES.finditer(content):
        raw_key = match.group("key")
        key = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", raw_key)
        key = key.lower().replace("-", "_").strip("_")
        if not any(key == part or key.endswith("_" + part) for part in SECRET_KEY_PARTS):
            continue
        value = _assignment_value(
            content,
            match.end(),
            match.group("separator"),
            python_source=python_source,
            literal_only=python_source and key == "token",
            json_source=source_suffix == ".json",
        )
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
        match = re.fullmatch(r"https://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?", url)
        if not match:
            raise RepositoryTargetError("Repository URL must be a canonical GitHub HTTPS URL")
        if match.group(1).lower() not in settings.allowed_orgs:
            raise RepositoryTargetError("Repository owner is not in ACADEMY_GITHUB_ALLOWED_ORGS")

    async def clone_or_update(self, name: str, url: str) -> Path:
        """Clone or fast-forward an allowlisted repository into the confined data root."""
        self._validate_target(name, url)
        url = url.replace("https://www.github.com/", "https://github.com/", 1)
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
            total_bytes = 0
            for path in repo_path.rglob("*"):
                if len(chunks) >= settings.max_scan_files or total_bytes >= settings.max_scan_bytes:
                    break
                relative = path.relative_to(repo_path)
                if not path.is_file() or any(part in IGNORED_DIRS for part in relative.parts[:-1]):
                    continue
                if path.name in IGNORED_NAMES or path.suffix.lower() not in ALLOWED_SUFFIXES:
                    continue
                try:
                    if path.is_symlink():
                        continue
                    file_size = path.stat().st_size
                    if file_size > settings.max_file_bytes or total_bytes + file_size > settings.max_scan_bytes:
                        continue
                    content = path.read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    continue
                # Never index files with credential assignments or recognizable secret formats.
                if contains_secret(content, path.suffix.lower()):
                    continue
                chunks.append({
                    "path": path.relative_to(repo_path).as_posix(),
                    "language": path.suffix.lstrip(".").lower(),
                    "content": content,
                })
                total_bytes += file_size
            return chunks

        return await asyncio.to_thread(operation)
