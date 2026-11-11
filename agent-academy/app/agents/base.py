from litellm import acompletion

from app.config import settings


class BaseAgent:
    def __init__(self, name: str, system_prompt: str):
        self.name = name
        self.system_prompt = system_prompt

    async def execute(self, user_prompt: str) -> str:
        if not settings.llm_enabled:
            raise RuntimeError("LLM execution is disabled; set ACADEMY_LLM_ENABLED=true explicitly")
        response = await acompletion(
            model=settings.default_model,
            api_base=settings.ollama_base_url,
            messages=[
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            timeout=45,
        )
        content = response.choices[0].message.content
        return content or ""
