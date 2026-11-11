from app.agents.base import BaseAgent


class OptimizerAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            "Optimizer",
            "You are a cautious workflow optimizer. Propose measurable, reversible improvements. "
            "Do not execute changes, expose secrets, or weaken security and quality gates.",
        )

    async def propose(self, logs: str) -> str:
        return await self.execute(
            "Review these sanitized execution logs. Return observations, root-cause hypotheses, "
            "a measurable experiment and rollback criteria. Do not reproduce credentials.\n\n" + logs[:20_000]
        )
