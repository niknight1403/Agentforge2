from fastapi import FastAPI

from app.api.endpoints import router
from app.config import settings

app = FastAPI(title=settings.project_name, version="0.1.0")
app.include_router(router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "agent-academy", "llm_enabled": settings.llm_enabled}
