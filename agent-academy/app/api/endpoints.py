import secrets
from fastapi import APIRouter, Depends, Header, HTTPException

from app.agents.auditor import AuditorAgent
from app.agents.professor import ProfessorAgent
from app.agents.optimizer import OptimizerAgent
from app.config import settings
from app.ingestion.github_scanner import GitHubScanner
from app.ingestion.knowledge_store import KnowledgeStore
from app.schemas import AnalyzeRequest, OptimizeRequest, SyncRequest

router = APIRouter(prefix="/api/academy", tags=["Agent Academy"])
scanner = GitHubScanner()
store = KnowledgeStore()
indexed: dict[str, list[dict[str, str]]] = {}


async def require_token(authorization: str | None = Header(default=None)) -> None:
    if not settings.api_token:
        raise HTTPException(status_code=503, detail="Academy API token is not configured")
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not secrets.compare_digest(supplied, settings.api_token):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token")


@router.post("/sync-repos", dependencies=[Depends(require_token)])
async def sync_repositories(payload: SyncRequest):
    results = {}
    for target in payload.repositories:
        try:
            path = await scanner.clone_or_update(target.name, str(target.url))
            chunks = await scanner.scan(path)
            store.replace_repository(target.name, chunks)
            indexed[target.name] = chunks
            results[target.name] = {"status": "indexed", "files": len(chunks)}
        except Exception as exc:
            results[target.name] = {"status": "failed", "error": str(exc)}
    return {"status": "completed" if all(v["status"] == "indexed" for v in results.values()) else "partial", "repositories": results}


@router.post("/analyze-synergies", dependencies=[Depends(require_token)])
async def analyze_synergies(payload: AnalyzeRequest):
    selected = payload.repository_names or list(indexed)
    evidence = []
    for name in selected:
        if name not in indexed:
            raise HTTPException(status_code=404, detail=f"Repository not indexed: {name}")
        evidence.append(f"## {name}\n" + "\n".join(
            f"- {item['path']} ({item['language']})" for item in indexed[name][:200]
        ))
    audit = AuditorAgent().audit({name: indexed[name] for name in selected})
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
    if not payload.use_llm:
        return {"status": "success", "optimization_report": "LLM disabled for this request; no prompt or workflow changes were applied."}
    try:
        result = await OptimizerAgent().propose(payload.execution_logs)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Optimizer unavailable: {type(exc).__name__}") from exc
    return {"status": "success", "optimization_report": result}


@router.get("/knowledge/search", dependencies=[Depends(require_token)])
async def search_knowledge(q: str, limit: int = 10):
    return {"results": store.search(q, limit)}
