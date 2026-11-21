import asyncio
import logging
import secrets
from pathlib import Path
from filelock import FileLock, Timeout as FileLockTimeout
from fastapi import APIRouter, Depends, Header, HTTPException

from app.agents.auditor import AuditorAgent
from app.agents.professor import ProfessorAgent
from app.agents.optimizer import OptimizerAgent
from app.config import settings
from app.ingestion.github_scanner import GitHubScanner, RepositoryValidationError
from app.ingestion.knowledge_store import KnowledgeStore
from app.schemas import AnalyzeRequest, OptimizeRequest, SyncRequest

router = APIRouter(prefix="/api/academy", tags=["Agent Academy"])
scanner = GitHubScanner()
store = KnowledgeStore()
logger = logging.getLogger(__name__)


async def require_token(authorization: str | None = Header(default=None)) -> None:
    """Require a configured service token and a valid Bearer authorization header."""
    if not settings.api_token:
        raise HTTPException(status_code=503, detail="Academy API token is not configured")
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(
        supplied.strip().encode("utf-8"), settings.api_token.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token")


@router.post("/sync-repos", dependencies=[Depends(require_token)])
async def sync_repositories(payload: SyncRequest):
    """Clone and index allowlisted repositories, reporting failures per target."""
    names = [target.name.casefold() for target in payload.repositories]
    if len(names) != len(set(names)):
        raise HTTPException(status_code=422, detail="Repository names must be unique within a sync request")

    results = {}
    lock_dir = settings.data_dir / ".locks"
    await asyncio.to_thread(lock_dir.mkdir, parents=True, exist_ok=True)
    for target in payload.repositories:
        lock = FileLock(str(lock_dir / f"{target.name.casefold()}.lock"), timeout=120)
        acquired = False
        try:
            await asyncio.to_thread(lock.acquire)
            acquired = True
            path = await scanner.clone_or_update(target.name, str(target.url))
            chunks = await scanner.scan(path)
            count = await asyncio.to_thread(store.replace_repository, target.name, chunks)
            results[target.name] = {"status": "indexed", "files": count}
        except RepositoryValidationError as exc:
            results[target.name] = {"status": "failed", "error": str(exc)}
        except FileLockTimeout:
            results[target.name] = {"status": "failed", "error": "Repository sync lock timed out"}
        except Exception:
            logger.exception("Sync failed for repository %s", target.name)
            results[target.name] = {"status": "failed", "error": "Internal error during sync"}
        finally:
            if acquired:
                await asyncio.to_thread(lock.release)
    return {"status": "completed" if all(v["status"] == "indexed" for v in results.values()) else "partial", "repositories": results}


@router.post("/analyze-synergies", dependencies=[Depends(require_token)])
async def analyze_synergies(payload: AnalyzeRequest):
    """Build a deterministic audit from persistent repository file metadata."""
    selected = payload.repository_names or await asyncio.to_thread(store.list_repositories)
    if not selected:
        raise HTTPException(status_code=404, detail="No repositories indexed")
    evidence = []
    repository_files = {}
    for name in selected:
        files = await asyncio.to_thread(store.list_files, name)
        if not files:
            raise HTTPException(status_code=404, detail=f"Repository not indexed: {name}")
        repository_files[name] = files
        evidence_files = files[:200]
        evidence.append(f"## {name}\n" + "\n".join(
            f"- {item['path']} ({item['language']})" for item in evidence_files
        ))
    audit = AuditorAgent().audit(repository_files)
    report = {"repositories": selected, "audit": audit, "evidence": "\n".join(evidence)}
    if payload.use_llm:
        try:
            report["synergy_report"] = await ProfessorAgent().analyze(report["evidence"])
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"LLM analysis unavailable: {type(exc).__name__}") from exc
    else:
        report["synergy_report"] = "LLM analysis not requested. Deterministic repository inventory and audit returned."
    return {"status": "success", **report}


@router.post("/optimize-agents", dependencies=[Depends(require_token)])
async def optimize_agents(payload: OptimizeRequest):
    """Return advisory workflow suggestions without applying any changes."""
    if not payload.use_llm:
        return {"status": "success", "optimization_report": "LLM disabled for this request; no prompt or workflow changes were applied."}
    try:
        result = await OptimizerAgent().propose(payload.execution_logs)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Optimizer unavailable: {type(exc).__name__}") from exc
    return {"status": "success", "optimization_report": result}


@router.get("/knowledge/search", dependencies=[Depends(require_token)])
async def search_knowledge(q: str, limit: int = 10):
    """Search the persistent knowledge index using a worker thread."""
    return {"results": await asyncio.to_thread(store.search, q, limit)}
