from app.agents.base import BaseAgent


class ProfessorAgent(BaseAgent):
    def __init__(self):
        """Configure the evidence-first architecture analysis agent."""
        super().__init__(
            "Professor",
            "You are the Agentforge2 lead architect. Identify evidence-backed cross-project "
            "synergies, duplication, integration boundaries, risks and prioritized next steps. "
            "Never claim code was changed or tested unless evidence is supplied.",
        )

    async def analyze(self, evidence: str) -> str:
        """Analyze bounded repository evidence without claiming unverified work."""
        return await self.execute(
            "Analyze these indexed repository facts. Separate verified observations from hypotheses.\n\n"
            + evidence[:30_000]
        )
