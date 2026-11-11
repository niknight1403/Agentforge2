from app.ingestion.knowledge_store import KnowledgeStore


def test_replace_and_search_is_persistent(tmp_path):
    database = tmp_path / "academy.sqlite3"
    store = KnowledgeStore(database)
    count = store.replace_repository("sample", [{
        "path": "src/worker.py",
        "language": "py",
        "content": "async def process_task(): return 'verified task result'",
    }])
    assert count == 1
    results = KnowledgeStore(database).search("verified task")
    assert results
    assert results[0]["path"] == "src/worker.py"


def test_replace_repository_removes_stale_files(tmp_path):
    store = KnowledgeStore(tmp_path / "academy.sqlite3")
    store.replace_repository("sample", [{"path": "old.py", "language": "py", "content": "obsolete entry"}])
    store.replace_repository("sample", [{"path": "new.py", "language": "py", "content": "current entry"}])
    assert store.search("obsolete") == []
    assert store.search("current")[0]["path"] == "new.py"

def test_search_treats_fts_operators_as_literal_terms(tmp_path):
    store = KnowledgeStore(tmp_path / "academy.sqlite3")
    store.replace_repository("sample", [{
        "path": "README.md",
        "language": "md",
        "content": "and or not near are ordinary words here",
    }])

    assert store.search("and")
    assert store.search("verified OR") == []
