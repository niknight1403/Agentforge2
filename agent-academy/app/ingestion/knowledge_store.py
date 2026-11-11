import sqlite3
from pathlib import Path
from typing import Iterable

from app.config import settings


class KnowledgeStore:
    """Persistent, dependency-light FTS store; embeddings can be added behind this interface."""

    def __init__(self, database: Path | None = None):
        self.database = database or settings.data_dir / "academy.sqlite3"
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY,
                    repository TEXT NOT NULL,
                    path TEXT NOT NULL,
                    language TEXT NOT NULL,
                    content TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    UNIQUE(repository, path)
                )
            """)
            connection.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
                USING fts5(repository, path, content, content='documents', content_rowid='id')
            """)

    def _connect(self):
        connection = sqlite3.connect(self.database, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def replace_repository(self, repository: str, chunks: Iterable[dict[str, str]]) -> int:
        rows = list(chunks)
        with self._connect() as connection:
            connection.execute("DELETE FROM documents WHERE repository = ?", (repository,))
            connection.executemany(
                "INSERT INTO documents(repository,path,language,content,content_hash) VALUES(?,?,?,?,?)",
                [(repository, row["path"], row["language"], row["content"],
                  __import__("hashlib").sha256(row["content"].encode()).hexdigest()) for row in rows],
            )
            connection.execute("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')")
        return len(rows)

    def list_repositories(self) -> list[str]:
        """Return the distinct repository names currently stored in the index."""
        with self._connect() as connection:
            rows = connection.execute("SELECT DISTINCT repository FROM documents ORDER BY repository").fetchall()
        return [row[0] for row in rows]

    def list_files(self, repository: str) -> list[dict[str, str]]:
        """Return indexed file metadata without loading stored source contents."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT path, language FROM documents WHERE repository = ? ORDER BY path",
                (repository,),
            ).fetchall()
        return [{"path": row[0], "language": row[1]} for row in rows]

    def search(self, query: str, limit: int = 10) -> list[dict[str, str]]:
        """Search indexed documents using literal FTS5 tokens."""
        safe_query = " ".join(f'"{part}"' for part in query.split() if part.replace("_", "").isalnum())
        if not safe_query:
            return []
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT d.repository,d.path,d.language,substr(d.content,1,1600)
                   FROM documents_fts f JOIN documents d ON d.id=f.rowid
                   WHERE documents_fts MATCH ? LIMIT ?""",
                (safe_query, min(max(limit, 1), 50)),
            ).fetchall()
        return [{"repository": r[0], "path": r[1], "language": r[2], "excerpt": r[3]} for r in rows]
